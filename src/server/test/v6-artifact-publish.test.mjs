import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_NAMES, ARTIFACT_REV_PATTERN, SENTENCE_BUDGET_MS,
  assertArtifactKey, versionedKey, fixedKey, publishArtifacts,
} from '../curation/publish.mjs';
import { chaptersOf, storyDocument } from '../curation/story.mjs';
import { createWriter } from '../curation/llm.mjs';
import { buildStory } from '../../web/js/state.js';
import { publishRecognition } from '../processor/recognition.mjs';

/**
 * V6 T-22/T-23 产物发布：线上（处理器 Lambda）产出「每月精选」与「故事文案」。
 *
 * 这里要证的是五条**可执行**的纪律，不是「选得好看」：
 *   1. **只写白名单 key**——发布者的写权限靠代码 + IAM 双重守，代码这一半要在测里。
 *   2. **双写与缓存策略**——rev 版不可变可长缓存，固定名 no-store 兜底。
 *   3. **同输入同字节**——产物跨机器一致（章节按码点序，不依赖 ICU）。
 *   4. **失败不牵连照片**——产物写不出来，索引已经落盘，照片照样上线。
 *   5. **分组与播放器一致**——`chaptersOf()` 与 `buildStory()` 逐键比对，
 *      否则文案会贴到别的章上，且只在年份边界出错。
 *
 * Five executable rules: whitelisted keys, dual write with cache headers,
 * byte-identical output, artifacts failing without blocking publication, and
 * chapter grouping identical to the player's.
 */

const REV = 'a75ad99f29dd';

/** 指纹要 >= 64 字符，尾 24 位逐张不同，否则去重会把 10 张折成 1 张 */
function lqipOf(seed) {
  return `data:image/webp;base64,${'A'.repeat(44)}${String(seed).padStart(4, '0').repeat(6)}`;
}

/** 2026-11 的 10 张静态照片 + 一个不该被公开的字段（不变式 1 的检查靶子） */
function monthPhotos(count = 10) {
  return Array.from({ length: count }, (_, index) => {
    const id = `aaaa0000${String(index + 1).padStart(4, '0')}`;
    const photo = {
      id,
      type: 'image',
      year: 2026,
      month: 11,
      ratio: 1,
      album: 'family',
      lqip: lqipOf(index + 1),
    };
    if (index === 0) {
      // 这些字段如果漏进产物，就是不变式 1 的破口
      Object.assign(photo, {
        lat: 31.2304, lng: 121.4737, serial: 'SN-0001', takenAt: '2026-11-03T21:14:07', name: 'IMG_0042.HEIC',
      });
    }
    return photo;
  });
}

/** 每张照片一组互不相同的标签，否则多样性惩罚会把池子里的分拉平 */
function indexOf(photos) {
  const terms = ['lake', 'mountain', 'sky', 'tree', 'road', 'boat', 'wall', 'chair', 'cup', 'leaf'];
  return {
    items: photos.map((photo, index) => ({
      id: photo.id,
      labels: [
        { term: terms[index % terms.length], zh: `词${index % terms.length}`, confidence: 0.9 },
        { term: `extra${index}`, zh: '', confidence: 0.8 },
      ],
    })),
  };
}

function memoryStore() {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    CACHE_IMMUTABLE: 'public, max-age=31536000, immutable',
    CACHE_NO_STORE: 'no-store',
    async putJson(bucket, key, value) { objects.set(key, Buffer.from(JSON.stringify(value))); },
    async putBuffer(bucket, key, body, options = {}) {
      calls.push({ key, cacheControl: options.cacheControl || '' });
      objects.set(key, Buffer.from(body));
    },
    async readJson(bucket, key) {
      const body = objects.get(key);
      return body ? JSON.parse(body.toString('utf8')) : null;
    },
    async listKeys(bucket, prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

const json = (store, key) => JSON.parse(store.objects.get(key).toString('utf8'));

/* ---------------- 白名单 / whitelist ---------------- */

test('产物 key 只认 data/curation 与 data/story：路径穿越、绝对地址、别的前缀全部拒绝', () => {
  assert.deepEqual(ARTIFACT_NAMES, ['curation', 'story']);
  for (const key of [
    'data/curation.json',
    `data/curation.${REV}.json`,
    'data/story.json',
    `data/story.${REV}.json`,
  ]) {
    assert.equal(assertArtifactKey(key), key);
  }
  for (const key of [
    '../data/curation.json',
    'data/../photos/a.jpg',
    '/data/curation.json',
    'data/curation.json.bak',
    'data/version.json',
    'data/manifest.json',
    'photos/aaaa00000001/grid.webp',
    `data/curated.${REV}.json`,
    '',
    null,
    42,
  ]) {
    assert.throws(() => assertArtifactKey(key), /非法产物 key/, String(key));
  }
});

test('rev 不认识时只写固定名，不拼出一个非法 key', () => {
  assert.equal(versionedKey('curation', REV), `data/curation.${REV}.json`);
  assert.equal(versionedKey('curation', ''), '');
  assert.equal(versionedKey('curation', 'not-a-rev!'), '');
  assert.equal(fixedKey('story'), 'data/story.json');
  assert.equal(ARTIFACT_REV_PATTERN.test(REV), true);
});

/* ---------------- 双写 / dual write ---------------- */

test('两个产物各写 rev 版（immutable）与固定名（no-store），内容逐字节相同', async () => {
  const store = memoryStore();
  const photos = monthPhotos();
  const summary = await publishArtifacts({
    store, bucket: 'site', rev: REV, photos, items: indexOf(photos).items, log: {},
  });

  assert.equal(summary.curation.months, 1);
  assert.equal(summary.curation.key, `data/curation.${REV}.json`);
  assert.equal(summary.story.chapters, 1);
  assert.equal(summary.story.key, `data/story.${REV}.json`);
  // 没有模型凭据：一句话都没有，但产物照样成立
  assert.equal(summary.curation.sentences, 0);
  assert.equal(summary.story.sentences, 0);

  for (const name of ARTIFACT_NAMES) {
    const versioned = store.calls.find((call) => call.key === `data/${name}.${REV}.json`);
    const fixed = store.calls.find((call) => call.key === `data/${name}.json`);
    assert.equal(versioned.cacheControl, store.CACHE_IMMUTABLE, name);
    assert.equal(fixed.cacheControl, store.CACHE_NO_STORE, name);
    assert.ok(
      store.objects.get(`data/${name}.${REV}.json`).equals(store.objects.get(`data/${name}.json`)),
      `${name} 双写内容不一致`,
    );
  }
});

test('产物里没有任何定位 / 序列号 / 原始文件名 / 精确时间（不变式 1）', async () => {
  const store = memoryStore();
  const photos = monthPhotos();
  await publishArtifacts({ store, bucket: 'site', rev: REV, photos, items: indexOf(photos).items, log: {} });

  for (const key of Object.keys(Object.fromEntries(store.objects))) {
    const text = store.objects.get(key).toString('utf8');
    // 判据是「公开产物里不出现这些键」，不是「输入里没有」——输入里我故意塞了
    for (const fat of ['"lat"', '"lng"', '"serial"', '"takenAt"', 'IMG_0042', '31.23']) {
      assert.ok(!text.includes(fat), `${key} 泄漏了 ${fat}`);
    }
  }
});

test('同一输入重复发布逐字节一致（章节按码点序，不依赖 ICU）', async () => {
  const photos = monthPhotos();
  const items = indexOf(photos).items;
  const first = memoryStore();
  const second = memoryStore();
  // 第二次把输入顺序打乱：产物不该因此改变
  await publishArtifacts({ store: first, bucket: 'site', rev: REV, photos, items, log: {} });
  await publishArtifacts({
    store: second, bucket: 'site', rev: REV, photos: [...photos].reverse(), items: [...items].reverse(), log: {},
  });

  for (const name of ARTIFACT_NAMES) {
    assert.equal(
      first.objects.get(`data/${name}.${REV}.json`).toString('utf8'),
      second.objects.get(`data/${name}.${REV}.json`).toString('utf8'),
      `${name} 对输入顺序敏感`,
    );
  }
});

test('没有月份凑齐 9 张：不写策展产物，故事照写（空章节也是通的一条路）', async () => {
  const store = memoryStore();
  // 同一个月只有 8 张：不够一块「精选」
  const photos = monthPhotos(8);
  const summary = await publishArtifacts({
    store, bucket: 'site', rev: REV, photos, items: indexOf(photos).items, log: {},
  });

  assert.equal(summary.curation.months, 0);
  assert.equal(summary.curation.key, '');
  assert.equal(store.objects.has('data/curation.json'), false);
  assert.equal(store.objects.has(`data/curation.${REV}.json`), false);

  assert.equal(summary.story.key, `data/story.${REV}.json`);
  assert.equal(json(store, 'data/story.json').chapters.length, 1);
});

test('视频不进精选：一个月 9 张但其中 4 段视频，凑不出 9 张静态图', async () => {
  const store = memoryStore();
  const photos = monthPhotos(9).map((photo, index) => (
    index < 4 ? { ...photo, type: 'video' } : photo
  ));
  const summary = await publishArtifacts({
    store, bucket: 'site', rev: REV, photos, items: indexOf(photos).items, log: {},
  });
  assert.equal(summary.curation.months, 0);
});

/* ---------------- 文案与时限 / copy and deadline ---------------- */

test('模型能答就用模型的句子；超时则退回派生文案，产物照发', async () => {
  const photos = monthPhotos();
  const items = indexOf(photos).items;

  const answering = memoryStore();
  const writer = {
    enabled: true,
    async write(rev, jobs) {
      const map = new Map();
      for (const job of jobs) map.set(job.key, '这一天走得很慢');
      return map;
    },
  };
  const withCopy = await publishArtifacts({
    store: answering, bucket: 'site', rev: REV, photos, items, writer, log: {},
  });
  assert.equal(withCopy.curation.sentences, 1);
  assert.equal(json(answering, 'data/curation.json').months[0].sentence, '这一天走得很慢');
  assert.equal(json(answering, 'data/story.json').chapters[0].subtitle, '这一天走得很慢');

  const hanging = { enabled: true, write: () => new Promise(() => {}) };
  const startedAt = Date.now();
  const withoutCopy = await publishArtifacts({
    store: memoryStore(), bucket: 'site', rev: REV, photos, items, writer: hanging, sentenceBudgetMs: 30, log: {},
  });
  assert.ok(Date.now() - startedAt < 2000, '没有在时限内放弃模型');
  assert.equal(withoutCopy.curation.sentences, 0);
  assert.ok(SENTENCE_BUDGET_MS > 0);
});

/* ---------------- 失败不牵连照片 / contained failure ---------------- */

test('产物写失败不影响索引：照片上线与索引都已经落盘', async () => {
  const store = memoryStore();
  const rejected = { ...store, async putBuffer(bucket, key, body, options) {
    if (key.startsWith('data/curation.')) throw new Error('AccessDenied');
    return store.putBuffer(bucket, key, body, options);
  } };
  const photos = monthPhotos();
  await store.putJson('site', 'data/version.json', { manifest: 'data/manifest.json', rev: 'x' });
  await store.putJson('site', 'data/manifest.json', { photos });

  const result = await publishRecognition({
    siteBucket: 'site', assetId: photos[0].id, recognition: null, correlationId: '', io: { store: rejected },
  });

  assert.ok(result.rev, '索引没发出来');
  assert.equal(result.artifacts, null, '失败应当被吞在 artifacts 字段里');
  assert.ok(store.objects.has(`data/search-index.${result.rev}.json`), 'rev 版索引没写');
  assert.ok(store.objects.has('data/search-index.json'), '兜底版索引没写');
});

test('发布成功时索引与两个产物都在，artifacts 摘要可核对', async () => {
  const store = memoryStore();
  const photos = monthPhotos();
  await store.putJson('site', 'data/version.json', { manifest: 'data/manifest.json', rev: 'x' });
  await store.putJson('site', 'data/manifest.json', { photos });

  const result = await publishRecognition({
    siteBucket: 'site', assetId: photos[0].id, recognition: null, correlationId: '', io: { store },
  });

  assert.equal(result.artifacts.curation.months, 1);
  assert.equal(result.artifacts.story.chapters, 1);
  assert.ok(store.objects.has('data/curation.json'));
  assert.ok(store.objects.has('data/story.json'));
  // 索引里的条目数就是 manifest 的照片数
  assert.equal(json(store, 'data/search-index.json').items.length, photos.length);
});

/* ---------------- 分组与播放器一致 / grouping parity ---------------- */

test('chaptersOf() 与播放器 buildStory() 逐键一致：单年按月、跨年按年、空输入', () => {
  const months = monthPhotos(4);
  const singleYear = months.map((photo, index) => ({ ...photo, month: index < 2 ? 3 : 11 }));
  const twoYears = [
    ...months,
    ...months.map((photo) => ({ ...photo, id: `${photo.id}y`, year: 2025 })),
  ];
  const cases = [[], months, singleYear, twoYears, [...twoYears].reverse()];

  for (const list of cases) {
    const mine = chaptersOf(list);
    const theirs = buildStory(list);
    assert.equal(mine.byYear, theirs.byYear);
    assert.deepEqual(mine.chapters.map((chapter) => chapter.key), theirs.chapters.map((chapter) => chapter.key));
    for (let i = 0; i < mine.chapters.length; i += 1) {
      assert.equal(mine.chapters[i].label, theirs.chapters[i].label);
      // 组内顺序不比：播放器用 localeCompare 决定同分先后，产物用码点序，
      // 两者对十六进制 id 结果相同，但那是巧合，不该写进断言
      assert.deepEqual(
        mine.chapters[i].items.map((photo) => photo.id).sort(),
        theirs.chapters[i].items.map((photo) => photo.id).sort(),
      );
    }
  }
});

test('章节缺年份或 id 的条目被丢掉，而不是分出一个 key 为 NaN 的章', () => {
  const ok = monthPhotos(2);
  const { chapters } = chaptersOf([...ok, { month: 5 }, { id: 'noyear', month: 5 }, null]);
  assert.equal(chapters.length, 1);
  assert.ok(chapters.every((chapter) => !chapter.key.includes('NaN')));
  // 空输入不产出空章节，故事产物因此是「有产物、无章节」
  assert.deepEqual(chaptersOf([]).chapters, []);
  assert.equal(storyDocument({ rev: REV, chapters: [] }).ending, '');
});

/* ---------------- 镜像边界 / image boundary ---------------- */

test('发布链路的 import 图不越出 src/server/：镜像只 COPY 这一层', async () => {
  // 这一条是这次搬迁的根因守卫：规则模块原本住在 src/build/，镜像里根本没有它，
  // 于是「本地构建有产物、线上没有」。物理共享不可能（镜像只 COPY src/server/，
  // 前端只拷 src/web/js/），所以用一条遍历 import 图的用例把边界钉住。
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const seen = new Set();
  const escaped = [];

  async function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!target.startsWith(serverRoot + path.sep)) {
        escaped.push(`${path.relative(serverRoot, file)} -> ${match[1]}`);
        continue;
      }
      await walk(target);
    }
  }

  await walk(path.join(serverRoot, 'processor', 'handler.mjs'));
  assert.ok(seen.size > 10, `只走到了 ${seen.size} 个文件，import 图没解析成功`);
  assert.deepEqual(escaped, [], '处理器 import 了镜像里不存在的文件');
  assert.ok([...seen].some((file) => file.endsWith(`curation${path.sep}publish.mjs`)), '处理器没有走到产物发布');
});

/* ---------------- 凭据来源 / where the key comes from ---------------- */

const LLM = {
  endpoint: 'https://llm.test/v1/chat', model: 'm', key: '', keyParam: '/album/photos/llm-api-key',
};

test('密钥只从 SSM 路径取：请求头里带它，URL、body、日志里都没有', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"key":"k1","text":"风很大"}]' } }] }) };
  };
  const asked = [];
  const writer = createWriter({
    config: LLM,
    fetchImpl,
    loadParam: async (name) => { asked.push(name); return 'super-secret-value'; },
  });

  assert.equal(writer.enabled, true);
  const out = await writer.write('rev1234', [{ key: 'k1', facts: {} }]);

  assert.equal(out.get('k1'), '风很大');
  assert.deepEqual(asked, ['/album/photos/llm-api-key'], '应当只按路径取一次');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, 'Bearer super-secret-value');
  assert.ok(!calls[0].url.includes('super-secret-value'), '密钥进了 URL');
  assert.ok(!calls[0].body.includes('super-secret-value'), '密钥进了请求体');
  // 再要一次同样的 key：内存缓存命中，不再取凭据、不再请求
  await writer.write('rev1234', [{ key: 'k1', facts: {} }]);
  assert.equal(asked.length, 1);
  assert.equal(calls.length, 1);
});

test('凭据取不到 = 没接模型：不请求、不抛错，日志里不出现密钥', async () => {
  const logs = [];
  let called = 0;
  const writer = createWriter({
    config: LLM,
    fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; },
    loadParam: async () => { throw new Error('AccessDenied'); },
    logger: (message) => logs.push(message),
  });

  const out = await writer.write('rev1234', [{ key: 'k1', facts: {} }]);
  assert.equal(out.size, 0);
  assert.equal(called, 0, '拿不到凭据就不该发请求');
  assert.ok(logs.some((line) => line.includes('凭据读取失败')));
  assert.ok(logs.every((line) => !line.includes('super-secret')), '日志里不许出现密钥');
});

test('测试的 import 图里不许**静态**出现第三方包：CI 一个包都不装', async () => {
  // 来自一次真实事故：hero.mjs 顶层整包 import 了 store.mjs，而 store.mjs 顶层
  // import 了 @aws-sdk/client-s3。那个包只在镜像的 package.json 里，CI 装的是
  // 仓库根依赖——于是整份 v6-hero 测试在 CI 上整体失败（连一条断言都没跑到），
  // 本地却全绿，因为本地 node_modules 恰好有 AWS SDK。这种「只在 CI 红」的错
  // 最难查，所以用一条不执行代码的静态扫描把它挡在门口。
  //
  // 范围比 AWS SDK 更大：build-image.yml 的单测 job **不装任何依赖**（那是它
  // 存在的意义——纯函数不需要安装）。所以 `sharp`、`exifr` 一样会炸，第一次
  // 修完 SDK 后紧接着就是 `video.mjs` 的 sharp。规则统一成一句：从测试文件
  // 出发，静态 import 图里只许出现相对路径与 `node:` 内置模块。
  //
  // 只看**静态** import：`await import(...)` 是运行期才加载的，正是修法本身
  // （只有真要用到时才把那个包拉进来）。
  const { readFile, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const testDirs = [path.join(here, 'server', 'test'), path.join(here, 'web', 'test')];
  const offenders = [];

  const specsOf = (source) => [
    ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
  ]
    .map((match) => match[1])
    // 用例里也会出现「用正则断言某文件 import 了什么」，那里面的 `from '\.\/x\.js'`
    // 是正则源码不是 import——真实模块路径里不会出现反斜杠，用这一条区分。
    // A test may itself assert on import statements via a regex literal; those
    // specifiers carry backslashes, which no real module path ever does.
    .filter((spec) => !spec.includes('\\'));

  // 模块图里可能有环（A import B，B import A），走一遍就记下来，避免原地打转。
  const seen = new Set();

  async function walk(file, trail) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const spec of specsOf(source)) {
      if (spec.startsWith('.')) {
        await walk(path.resolve(path.dirname(file), spec), trail);
        continue;
      }
      // 内置模块与 URL 形式（node:、file:、data:）都不需要安装。
      if (spec.startsWith('node:') || spec.startsWith('file:') || spec.startsWith('data:')) continue;
      // 剩下的都是裸包名：要么在 node_modules 里（CI 没有），要么是 URL。
      if (/^(?:[a-z]+:)?\/\//i.test(spec)) continue;
      offenders.push(`${trail} → ${spec}`);
    }
  }

  for (const dir of testDirs) {
    for (const name of await readdir(dir)) {
      if (name.endsWith('.test.mjs')) await walk(path.join(dir, name), name);
    }
  }
  assert.deepEqual(offenders, [], '测试静态依赖了 CI 单测 job 里没装的包（那个 job 不装依赖）');
});
