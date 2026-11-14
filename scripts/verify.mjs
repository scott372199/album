import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeEditorialRows, layoutParams, buildHash, parseHashString, buildStory, PACE,
} from '../src/web/js/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
let checks = 0;

function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

async function okAsync(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function mockState() {
  return {
    view: 'album',
    album: '2026-京都',
    q: '海边 日落 & 咖啡',
    tag: '旅行',
    year: '2026',
    month: '11',
    filtered: [{ id: 'abc123' }, { id: 'def456' }],
    lightbox: { index: 1 },
  };
}

console.log('--- 第三版本地结构验证 ---');

/* 1. 编辑式行模型（feature 大图 + strip 小图组） */
const OPTS_1200 = layoutParams(1200);

ok('computeEditorialRows 保持条目顺序且覆盖全部照片', () => {
  const items = [1.5, 0.8, 1.3333, 0.5625, 2, 1.1, 0.75, 1.6].map((ratio, id) => ({ id, ratio }));
  const rows = computeEditorialRows(items, 1200, OPTS_1200);
  const flat = rows.flatMap((row) => row.items);
  assert.equal(flat.length, items.length);
  assert.deepEqual(flat.map((x) => x.id), items.map((x) => x.id));
});

ok('strip 行正好等比填满容器（不裁切的几何前提）', () => {
  const width = 1200;
  const { gap } = OPTS_1200;
  const items = Array.from({ length: 30 }, (_, id) => ({ id, ratio: 0.6 + (id % 5) * 0.35 }));
  const rows = computeEditorialRows(items, width, OPTS_1200);
  for (const row of rows) {
    assert.ok(row.height > 0, '行高必须为正');
    if (row.type !== 'strip') continue;
    const sumRatio = row.items.reduce((sum, item) => sum + item.ratio, 0);
    const total = row.height * sumRatio + (row.items.length - 1) * gap;
    assert.ok(Math.abs(total - width) < 1e-6, `strip 行宽 ${total} 未填满 ${width}`);
  }
});

ok('feature 行整行一张，高度夹在 [featureMin, featureMax]', () => {
  const items = Array.from({ length: 12 }, (_, id) => ({ id, ratio: id % 3 === 0 ? 0.56 : 1.5 }));
  const rows = computeEditorialRows(items, 1200, OPTS_1200);
  const features = rows.filter((row) => row.type === 'feature');
  assert.ok(features.length > 0, '应当存在大图行');
  for (const row of features) {
    assert.equal(row.items.length, 1);
    assert.ok(row.height >= OPTS_1200.featureMin - 1e-9);
    assert.ok(row.height <= OPTS_1200.featureMax + 1e-9);
  }
});

ok('strip 行不超过 maxPerRow，且首条必为大图', () => {
  const items = Array.from({ length: 20 }, (_, id) => ({ id, ratio: 1.4 }));
  const rows = computeEditorialRows(items, 800, layoutParams(800));
  assert.equal(rows[0].type, 'feature');
  const max = layoutParams(800).maxPerRow;
  for (const row of rows) {
    if (row.type === 'strip') assert.ok(row.items.length <= max, `strip 行 ${row.items.length} 超过 ${max}`);
  }
});

ok('视频条目会触发大图行，且空输入 / 非法 ratio 兜底', () => {
  assert.deepEqual(computeEditorialRows([], 1000, OPTS_1200), []);
  const rows = computeEditorialRows([{ ratio: 0 }, { ratio: 'abc' }], 1000, OPTS_1200);
  const all = rows.flatMap((row) => row.items);
  assert.equal(all.length, 2);
  // 非法 ratio 视作 1：单条大图行的高度应等于 clamp(width / 1)
  const solo = computeEditorialRows([{ ratio: 0 }], 1000, OPTS_1200);
  assert.equal(solo.length, 1);
  assert.equal(solo[0].height, Math.min(OPTS_1200.featureMax, 1000));

  const mixed = [
    { id: 'a', ratio: 1.5 }, { id: 'b', ratio: 1.5 },
    { id: 'c', ratio: 1.5 }, { id: 'v', ratio: 0.5625, type: 'video' },
  ];
  const withVideo = computeEditorialRows(mixed, 1200, OPTS_1200);
  const videoRow = withVideo.find((row) => row.items.some((item) => item.id === 'v'));
  assert.equal(videoRow.type, 'feature', '视频应独占一行');
});

ok('layoutParams 随容器宽度单调变化', () => {
  const widths = [600, 800, 1100, 1300];
  const params = widths.map((w) => layoutParams(w));
  for (let i = 1; i < params.length; i += 1) {
    assert.ok(params[i].gap >= params[i - 1].gap);
    assert.ok(params[i].target >= params[i - 1].target);
    assert.ok(params[i].featureMax >= params[i - 1].featureMax);
  }
});

ok('buildStory 跨年按年分章、单年按月分章', () => {
  const multi = [
    { id: 'a', year: 2024, month: 5 }, { id: 'b', year: 2026, month: 11 },
    { id: 'c', year: 2026, month: 3 },
  ];
  const story = buildStory(multi);
  assert.equal(story.byYear, true);
  assert.equal(story.chapters.length, 2);
  assert.deepEqual(story.chapters.map((c) => c.key), ['2024', '2026']);

  const single = [
    { id: 'a', year: 2026, month: 11 }, { id: 'b', year: 2026, month: 3 },
  ];
  const byMonth = buildStory(single);
  assert.equal(byMonth.byYear, false);
  assert.deepEqual(byMonth.chapters.map((c) => c.label), ['2026 · 3 月', '2026 · 11 月']);
});

ok('故事节奏档位为正数且慢 > 标准 > 快', () => {
  assert.ok(PACE.slow > PACE.normal && PACE.normal > PACE.fast && PACE.fast > 0);
});

/* 2. URL hash 序列化 / 反序列化 */
ok('buildHash → parseHashString 往返一致（含中文与特殊字符）', () => {
  const original = mockState();
  const hash = buildHash(original);
  const restored = { lightbox: {} };
  const photoId = parseHashString(hash, restored);
  assert.equal(restored.view, 'album');
  assert.equal(restored.album, '2026-京都');
  assert.equal(restored.q, '海边 日落 & 咖啡');
  assert.equal(restored.tag, '旅行');
  assert.equal(restored.year, '2026');
  assert.equal(restored.month, '11');
  assert.equal(photoId, 'def456');
});

ok('故事 / 照片墙模式可往返', () => {
  for (const mode of ['story', 'wall']) {
    const hash = buildHash({ ...mockState(), mode, pace: 'fast' });
    const restored = { lightbox: {} };
    parseHashString(hash, restored);
    assert.equal(restored.mode, mode, `${mode} 模式未保留`);
    assert.equal(restored.pace, 'fast');
  }
  const restored = { lightbox: {} };
  parseHashString('#mode=bogus', restored);
  assert.equal(restored.mode, null);
});

ok('非法 hash 值容错回落到全量默认', () => {
  const restored = { lightbox: {} };
  parseHashString('#view=secret&year=abc&month=99&p=x', restored);
  assert.equal(restored.view, 'timeline');
  assert.equal(restored.year, '');
  assert.equal(restored.month, '');
});

ok('默认状态生成空 hash', () => {
  const empty = {
    view: 'timeline', album: '', q: '', tag: '', year: '', month: '',
    filtered: [], lightbox: { index: -1 }, mode: null,
  };
  assert.equal(buildHash(empty), '');
});

/* 3. 前端结构与产物 */
const html = await readFile(path.join(ROOT, 'src/web/index.html'), 'utf8');
const css = await readFile(path.join(ROOT, 'src/web/style.css'), 'utf8');
const jsDir = path.join(ROOT, 'src/web/js');
const jsNames = (await readdir(jsDir)).filter((f) => f.endsWith('.js')).sort();
const jsSources = await Promise.all(jsNames.map(async (f) => [f, await readFile(path.join(jsDir, f), 'utf8')]));
const allJs = jsSources.map(([, text]) => text).join('\n');

ok('前端已按模块拆分，入口为 main.js', () => {
  assert.ok(jsNames.includes('main.js'));
  for (const name of ['state.js', 'data.js', 'gallery.js', 'lightbox.js', 'story.js',
    'wall.js', 'motion.js', 'update.js', 'ui.js']) {
    assert.ok(jsNames.includes(name), `缺少模块 ${name}`);
  }
  assert.ok(!html.includes('app.js'), 'index.html 仍引用旧 app.js');
});

ok('JS 模块引用的所有 DOM id 都有定义（静态骨架或运行时模板）', () => {
  const ids = new Set([
    ...[...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    ...[...allJs.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
  ]);
  const used = [...new Set([...allJs.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((id) => !ids.has(id)), []);
});

ok('所有模块的 import 目标都存在', () => {
  for (const [name, text] of jsSources) {
    for (const match of text.matchAll(/from\s+'\.\/([^']+)'/g)) {
      assert.ok(jsNames.includes(match[1]), `${name} 引用了不存在的 ${match[1]}`);
    }
  }
});

function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop().trim();
      if (alias) names.add(alias);
    }
  }
  return names;
}

ok('所有具名 import 都能在目标模块找到对应导出', () => {
  const exportsByFile = new Map(jsSources.map(([name, text]) => [name, exportedNames(text)]));
  for (const [name, text] of jsSources) {
    for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)'/g)) {
      const target = exportsByFile.get(m[2]);
      if (!target) continue;
      for (const part of m[1].split(',')) {
        const wanted = part.trim().split(/\s+as\s+/)[0].trim();
        if (!wanted) continue;
        assert.ok(target.has(wanted), `${name} 从 ${m[2]} 导入了不存在的 ${wanted}`);
      }
    }
  }
});

ok('index.html 只保留四个构建占位符且无绝对外链', () => {
  // v4 起 __MANIFEST__ 被移除：清单地址在运行时由 version.json 解析，
  // 前端产物不再包含任何内容地址。__API_BASE__ 是接口地址（登录/取上传地址），
  // 属于配置而不是内容，构建时注入。
  // __MANIFEST__ was removed in v4. __API_BASE__ is configuration (the auth and
  // upload-url endpoint), not content, so it is injected at build time.
  for (const token of ['__TITLE__', '__STYLE__', '__APP__', '__API_BASE__']) {
    assert.ok(html.includes(token), `缺少占位符 ${token}`);
  }
  assert.ok(!html.includes('__MANIFEST__'), 'index.html 不应再注入清单地址');
  assert.ok(!html.includes('ALBUM_MANIFEST'), 'index.html 不应再注入全局清单变量');
  assert.ok(!html.includes('http://') && !html.includes('https://'));
});

await okAsync('接口地址在构建时注入，产物里不留占位符', async () => {
  const distHtml = await readFile(path.join(DIST, 'index.html'), 'utf8');
  assert.ok(!distHtml.includes('__API_BASE__'), 'dist/index.html 仍有未替换的接口占位符');
  assert.ok(
    /<meta name="album-api" content="[^"]*">/.test(distHtml),
    'dist/index.html 缺少 album-api meta',
  );
});

await okAsync('清单改为运行时解析，且 web 构建不依赖 photos/', async () => {
  const data = jsSources.find(([name]) => name === 'data.js')?.[1] || '';
  assert.ok(data.includes('export async function resolveManifest'), 'data.js 应导出 resolveManifest');
  assert.ok(data.includes('version.json'), 'resolveManifest 应先读 version.json');
  assert.ok(data.includes("cache: 'no-store'"), 'version.json 必须以 no-store 取，否则热更新失效');

  const build = await readFile(path.join(ROOT, 'src/build/build.mjs'), 'utf8');
  assert.ok(build.includes("'--target='"), 'build.mjs 应支持 --target');
  assert.ok(/TARGET === 'all'\s*\?\s*await buildFromPhotos/.test(build),
    'web 目标必须跳过照片处理');
  assert.ok(build.includes("if (TARGET === 'all') {\n    await writeFile(CACHE"),
    'web 目标不得写增量缓存，否则全量重建');

  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['build:web']?.includes('--target=web'), '缺少 build:web 脚本');
  assert.ok(pkg.scripts['build:all']?.includes('--target=all'), '缺少 build:all 脚本');
});

ok('style.css 含深浅章节、Apple 风格 token、不裁切与 reduced-motion', () => {
  for (const token of ['.section--dark', 'backdrop-filter', '--accent', '.tile',
    'object-fit: contain', 'prefers-reduced-motion', ':focus-visible',
    '.story-slide', '.wall-slide', '.hero-stage']) {
    assert.ok(css.includes(token), `缺少 ${token}`);
  }
});

ok('CSS 未对照片施加滤镜或裁切类属性', () => {
  // 允许 backdrop-filter（毛玻璃），禁止真正作用于照片的 filter
  assert.ok(!/(^|[^-a-z])filter\s*:/m.test(css), 'CSS 中不应出现 filter');
  assert.ok(!/object-fit:\s*cover/.test(css), '照片不得 cover 裁切');
});

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

await okAsync('dist 产物无 http:// 引用', async () => {
  const files = [
    path.join(DIST, 'index.html'),
    ...await walk(path.join(DIST, 'assets')),
    ...await walk(path.join(DIST, 'data')),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('http://'), `${path.relative(ROOT, file)} 含 http://`);
  }
});

const dataFiles = await readdir(path.join(DIST, 'data'));
const manifestName = dataFiles.find((f) => f.startsWith('manifest.'));
const manifest = JSON.parse(await readFile(path.join(DIST, 'data', manifestName), 'utf8'));

const IMAGE_KEYS = ['id', 'type', 'album', 'year', 'month', 'tags', 'title', 'caption',
  'ratio', 'lqip', 'featured', 'thumb', 'grid', 'view'];
const VIDEO_KEYS = ['id', 'type', 'album', 'year', 'month', 'tags', 'title', 'caption',
  'ratio', 'lqip', 'featured', 'poster', 'src', 'duration'];
const LIVE_KEYS = [...new Set([...IMAGE_KEYS, 'poster', 'src', 'duration'])];

ok('manifest 按类型遵守字段白名单', () => {
  assert.equal(typeof manifest.site.title, 'string');
  assert.equal(typeof manifest.hero, 'string');
  for (const photo of manifest.photos) {
    const expected = photo.type === 'video' ? VIDEO_KEYS
      : photo.type === 'live' ? LIVE_KEYS
        : photo.type === 'animation' ? ['id', 'type', 'album', 'year', 'month', 'tags', 'title',
          'caption', 'ratio', 'lqip', 'featured', 'poster', 'src']
          : IMAGE_KEYS;
    assert.deepEqual(Object.keys(photo).sort(), [...expected].sort(), `${photo.id} 字段不符`);
  }
});

ok('manifest 不含源路径 / 原始文件名 / 具体日期 / 文件大小', () => {
  const text = JSON.stringify(manifest);
  for (const forbidden of ['srcPath', '"rel"', 'mtime', '"size"', '"day"', 'hasAudio', '.MOV', '.JPG']) {
    assert.ok(!text.includes(forbidden), `manifest 中出现 ${forbidden}`);
  }
});

ok('每条都带 LQIP 占位且为内联 data URI', () => {
  for (const photo of manifest.photos) {
    assert.ok(photo.lqip.startsWith('data:image/webp;base64,'), `${photo.id} 缺少 lqip`);
    assert.ok(photo.lqip.length > 80);
  }
});

await okAsync('图片条目三档文件齐全，视频条目有短片与封面', async () => {
  for (const photo of manifest.photos) {
    if (photo.type === 'image' || photo.type === 'live') {
      for (const rel of [photo.thumb, photo.grid, photo.view]) {
        await access(path.join(DIST, rel));
      }
    }
    if (photo.type === 'video') {
      await access(path.join(DIST, photo.src));
      await access(path.join(DIST, photo.poster));
      assert.ok(photo.duration > 0 && photo.duration <= 30);
    }
  }
});

await okAsync('data/version.json 与 manifest 哈希一致', async () => {
  const version = JSON.parse(await readFile(path.join(DIST, 'data', 'version.json'), 'utf8'));
  assert.equal(version.manifest, `data/${manifestName}`);
  // 全量构建（--target=all）用内容哈希命名，rev 必须与文件名一致；
  // web 构建（--target=web）用固定名 manifest.json 以便本地预览，
  // 此时没有「文件名里的哈希」可比，只校验 rev 本身是个合法哈希。
  // all: hashed filename, rev must match it. web: fixed name for local preview,
  // so there is no hash in the name — only assert rev looks like one.
  if (/^manifest\.[0-9a-f]+\.json$/.test(manifestName)) {
    assert.equal(version.rev, manifestName.replace(/^manifest\./, '').replace(/\.json$/, ''));
  } else {
    assert.match(version.rev, /^[0-9a-f]{8,}$/);
  }
  assert.equal(version.counts.photos, manifest.photos.filter((p) => p.type !== 'video').length);
  assert.equal(version.counts.videos, manifest.photos.filter((p) => p.type === 'video').length);
});

await okAsync('JS 产物走目录级哈希，模块间相对引用可解析', async () => {
  const distHtml = await readFile(path.join(DIST, 'index.html'), 'utf8');
  const match = /src="(assets\/js\.[0-9a-f]+\/main\.js)"/.exec(distHtml);
  assert.ok(match, 'index.html 未引用目录级哈希入口');
  const entryDir = path.join(DIST, path.dirname(match[1]));
  const entrySource = await readFile(path.join(entryDir, 'main.js'), 'utf8');
  const locals = [...entrySource.matchAll(/from\s+'\.\/([^']+)'/g)].map((m) => m[1]);
  assert.ok(locals.length > 0, '入口应引用同目录模块');
  for (const name of locals) await access(path.join(entryDir, name));
});

ok('视频转码参数先取时间再清元数据，且带 faststart', async () => {
  const video = await readFile(path.join(ROOT, 'src/build/video.mjs'), 'utf8');
  for (const token of ['-map_metadata', '-map_chapters', '+bitexact', 'creation_time', '+faststart']) {
    assert.ok(video.includes(token), `视频转码缺少 ${token}`);
  }
  assert.ok(video.includes('probeVideo'), '应先探测元数据再转码');
});

const report = JSON.parse(await readFile(path.join(DIST, '.build-report.json'), 'utf8'));
ok('构建报告的 invalidation 状态合法（未部署为 null，已部署为结构体）', () => {
  const value = report.invalidation;
  if (value === null) return;
  assert.equal(typeof value, 'object');
  assert.equal(value.executed, true);
  assert.ok(Array.isArray(value.paths) && value.paths.includes('/index.html'));
  assert.ok(value.paths.includes('/data/version.json'));
});

/* 4. 基础设施配置
 *
 * v3 时代这里断言的是 src/deploy/ 下那套命令式脚本生成的 CloudFront /
 * 桶策略 / IAM 策略。v4 之后四层由 album-infra 仓库的 Terraform 管理，
 * 断言跟着代码一起搬走了：那边 `make check` 有 58 项离线断言，`terraform
 * plan` 本身就是最强的结构断言。前端仓库不再持有任何资源配置。
 *
 * v3 asserted the config produced by the imperative scripts that used to
 * live in src/deploy/. Since v4 those four layers belong to Terraform in
 * album-infra; the assertions moved with the code (58 offline checks plus
 * `terraform plan` itself). This repo holds no resource configuration.
 */

// ---------------------------------------------------------------------------
// v4：跨语言与跨仓库的契约
//
// 这几条防的都是「改一处、另一处静默失效」——原生桥的方法名、版本号的
// 唯一来源、发布流水线碰了不该碰的前缀。它们在正常跑测试时都不会报错，
// 只在真机或线上才现形。
// ---------------------------------------------------------------------------

await okAsync('代码里没有硬编码的桶名 / 账号 / 分发 ID', async () => {
  const files = [
    ...(await walk(path.join(ROOT, 'src'))).filter((f) => /\.(mjs|js)$/.test(f)),
    ...(await walk(path.join(ROOT, 'scripts'))).filter((f) => /\.mjs$/.test(f)),
  ];
  // config.json 本身就是配置，不算硬编码；这里只拦代码里出现真值——
  // 一旦散落在代码里，换桶或换分发就得满仓库找。
  //
  // 字面量拆开拼：本文件自己就是扫描目标，写整串会立刻自报。
  // `top/chenyouyi/album` 是安卓包名，不是资源配置，用负向断言排除。
  // Split on purpose: this file is itself scanned. `top/chenyouyi/album` is a
  // Java package name, not a resource reference, so it is excluded.
  const forbidden = [
    ['chen', 'youyi'].join(''),
    ['156487532', '333'].join(''),
    ['E2UWEFMO', 'KOQEES'].join(''),
    ['d3mvmo06', 'veyiuk'].join(''),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const token of forbidden) {
      assert.ok(
        !new RegExp(`(?<!top/)${token}`).test(text),
        `${path.relative(ROOT, file)} 硬编码了 ${token}；应放配置或环境变量`,
      );
    }
  }
});

await okAsync('前端只调用约定好的原生桥方法', async () => {
  const nativeSrc = await readFile(path.join(ROOT, 'src/web/js/native.js'), 'utf8');
  // 白名单与 album-android 仓库 scripts/check.mjs 的 BRIDGE 一致。跨仓库的
  // 另一半在那边断言（Kotlin 侧必须都带 @JavascriptInterface）；两边都过，
  // 桥才算对得上。这里只能钉住「网页没有悄悄多调一个不存在的方法」。
  const BRIDGE = ['setKeepScreenOn', 'reloadSite', 'appVersion'];
  const called = new Set(
    [...nativeSrc.matchAll(/AlbumNative\.(\w+)\s*\(/g)].map((m) => m[1]),
  );
  assert.ok(called.size > 0, 'native.js 应当调用至少一个桥方法');
  for (const name of called) {
    assert.ok(BRIDGE.includes(name), `native.js 调了 AlbumBridge 里没有的方法 ${name}`);
  }
  assert.ok(nativeSrc.includes('window.AlbumNative'), 'native.js 应检测 window.AlbumNative');
  // appVersion 只给排查用（原生侧把它印在日志/离线页上），网页不必调用，
  // 因此只在白名单里出现，不要求 native.js 引用它。
});

await okAsync('返回键的两段式契约在网页这一侧成立', async () => {
  const nativeSrc = await readFile(path.join(ROOT, 'src/web/js/native.js'), 'utf8');
  const mainSrc = await readFile(path.join(ROOT, 'src/web/js/main.js'), 'utf8');
  // 查询与执行必须分开：合成一个「既查又退」的函数，调用方永远分不清
  // 「退了一层」和「已经到底了」。原生侧按返回值决定要不要 finish()。
  for (const fn of ['__canGoBack', '__goBack']) {
    assert.ok(nativeSrc.includes(`window.${fn}`), `native.js 应挂上 ${fn}`);
  }
  assert.ok(
    /installBackBridge\(\{[^}]*canGoBack[^}]*goBack/.test(mainSrc),
    'main.js 必须把 canGoBack / goBack 一起交给原生桥',
  );
});


await okAsync('前端发布流水线不碰 photos/ 与 data/', async () => {
  const wf = await readFile(path.join(ROOT, '.github/workflows/deploy-web.yml'), 'utf8');
  const code = wf.replace(/#[^\n]*/g, '');
  // 根级 sync --delete 会把处理函数写进去的照片删光（v4 最危险的一条）
  assert.ok(
    !/s3\s+sync\s+dist\/\s/.test(code),
    '不得对 dist/ 整体 sync —— 产物里没有 photos/，根级 delete 会清空线上照片',
  );
  assert.ok(code.includes('dist/assets/'), '应只同步 assets/');
  // 出现 photos/ 本身不是问题——流水线里有一处专门的守卫就是为了在产物误含
  // 照片目录时拒绝发布。真正要拦的是「往上写」：任何把照片目录当目标的 s3 路径。
  assert.ok(!/s3:\/\/\S*photos/.test(code), '不得上传到 photos/ 前缀 —— 那里归处理函数管');
  assert.ok(code.includes('dist/photos'), '应保留「产物里有 photos/ 就拒绝发布」的守卫');
  assert.ok(!/\/data\/"+?\s*--delete/.test(code), 'data/ 归处理函数管，不应被 sync --delete');
});

await okAsync('镜像构建关掉了 provenance（否则 Lambda 拒绝 index 清单）', async () => {
  const wf = await readFile(path.join(ROOT, '.github/workflows/build-image.yml'), 'utf8');
  assert.ok(/provenance:\s*false/.test(wf), 'buildx 默认附加的证明清单会让 Lambda 拒收镜像');
  assert.ok(/platforms:\s*linux\/amd64/.test(wf), 'Lambda 不接受 arm64 镜像');
});


await okAsync('预签名把 content-type 与 x-amz-meta-* 纳入签名', async () => {
  const src = await readFile(path.join(ROOT, 'src/server/auth/upload.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // 只写 Metadata 不写 signableHeaders 时，客户端带上来的 x-amz-meta-* 会被
  // S3 判成「未签名头」直接 403 —— 这条断言就是钉住那个修复。
  assert.ok(
    /signableHeaders:\s*new Set\(/.test(code),
    'getSignedUrl 必须显式传 signableHeaders，否则直传 403 headers not signed',
  );
  // 只传 signableHeaders 不够：SDK 仍会把 x-amz-meta-* 提到查询串，
  // SignedHeaders 只剩 content-type;host，客户端带的头照样被判未签名。
  assert.ok(
    /unhoistableHeaders:\s*new Set\(/.test(code),
    '必须传 unhoistableHeaders：否则 x-amz-meta-* 会被搬进查询串而不进签名',
  );
  assert.ok(/signableHeaderNames\(/.test(code), '签名头清单应来自 rules.mjs 的纯函数');

  const rules = await readFile(path.join(ROOT, 'src/server/auth/rules.mjs'), 'utf8');
  assert.ok(/export function signableHeaderNames/.test(rules), 'rules.mjs 应导出 signableHeaderNames');
  assert.ok(rules.includes('x-amz-meta-'), '应拼出 x-amz-meta-<name> 形式的头名');
});

await okAsync('前端引用的元素 id 都存在于模板里', async () => {
  // el('x') 只是 getElementById 的薄包装：拼错一个 id 不报错，只会在运行时
  // 「点了没反应」。加按钮/输入框时最容易踩，所以静态对齐一次。
  const dir = path.join(ROOT, 'src/web/js');
  const html = await readFile(path.join(ROOT, 'src/web/index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = new Set();
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue;
    const code = await readFile(path.join(dir, file), 'utf8');
    for (const m of code.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)) {
      if (!ids.has(m[1])) missing.add(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual([...missing], [], `模板里找不到这些 id：${[...missing].join(', ')}`);
});

await okAsync('分片上传的两端约定一致', async () => {
  const client = await readFile(path.join(ROOT, 'src/web/js/upload.js'), 'utf8');
  const handler = await readFile(path.join(ROOT, 'src/server/auth/handler.mjs'), 'utf8');
  const upload = await readFile(path.join(ROOT, 'src/server/auth/upload.mjs'), 'utf8');
  // 客户端拼的路径与服务端 routeKey 必须逐字一致，否则分片传完合并不了，
  // 而合成失败发生在「片都传上去了」之后，最难查。
  assert.ok(client.includes("'/upload-complete'"), '客户端应调用 /upload-complete');
  assert.ok(handler.includes("case 'POST /upload-complete'"), 'handler 应有 POST /upload-complete 路由');
  // 服务端返回的分片描述字段，客户端必须都用到
  for (const field of ['multipart', 'uploadId', 'partSize', 'parts']) {
    assert.ok(upload.includes(field), `服务端应返回 ${field}`);
    assert.ok(client.includes(field), `客户端应使用 ${field}`);
  }
  // 客户端必须把 ETag 带回去合并，否则 CompleteMultipartUpload 会报 InvalidPart
  assert.ok(client.includes("getResponseHeader('etag')"), '必须读取响应头里的 ETag');
  assert.ok(client.includes('partNumber'), '合并请求需要 partNumber');
});

await okAsync('Docker 构建上下文包含 V5 契约（.dockerignore 未整体排除 spec/）', async () => {
  const ignore = await readFile(path.join(ROOT, '.dockerignore'), 'utf8');
  const lines = ignore.split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  // Dockerfile 的 COPY 源必须在构建上下文里；整体排除 spec/ 会让 build 直接失败。
  // The Dockerfile COPY source must be in the build context; excluding spec/
  // wholesale breaks the build outright.
  assert.ok(!lines.includes('spec'), '.dockerignore 不能整体排除 spec/');
  const dockerfile = await readFile(path.join(ROOT, 'docker/Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY spec\/v5\/contracts\/v5-contracts\.json/);
  await access(path.join(ROOT, 'spec/v5/contracts/v5-contracts.json'));
});

console.log(`--- 全部通过：${checks} 项断言 ---`);
