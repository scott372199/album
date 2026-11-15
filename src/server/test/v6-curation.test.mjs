import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CURATION_VERSION, MONTH_MIN_PHOTOS, MONTH_PICKS,
  monthKey, isStill, labelsFromIndex, topLabels, clarityScore, densityScore, ratioFit,
  scoreOf, fingerprintOf, foldNearDuplicates, pickMonth, curateMonths,
  cleanSentence, applySentences, curationDocument, curationFor, isCurationUsable,
} from '../../build/curation.mjs';
import {
  PROMPT_VERSION, llmConfig, sanitizeSentence, parseSentences, createWriter,
} from '../../build/llm.mjs';

/**
 * V6 T-22 每月策展：规则选片 + 产物 + 文案降级。
 *
 * 这里要证的不是「选得好看」——那是审美，验收时人工抽查。要证的是四条**可执行**
 * 的纪律：
 *   1. 门槛是硬的：画面不足 9 张不出块，折叠后不足 9 张也不出块。
 *   2. 选片不看输入顺序：同一份清单打乱后重跑，结果逐字节相同（幂等）。
 *   3. 产物只带白名单字段：lqip、ratio、tags 一个都不许进公开产物。
 *   4. 没有模型凭据时构建照常成功，只是没有那句导读。
 *
 * What must hold here is not taste but four executable disciplines: a hard
 * threshold, order-independent (idempotent) selection, a whitelisted artifact,
 * and a build that succeeds with no model credentials.
 */

/* ---------- 夹具 / Fixtures ---------- */

const labels = (...terms) => terms.map((term) => ({ term, zh: term, kind: 'object', confidence: 1 }));

/** 一整个月的照片：只带规则要用的字段 */
function monthPhotos(year, month, count, extra = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${String(i).padStart(2, '0')}`,
    type: 'image',
    album: `${year}`,
    year,
    month,
    ratio: 1.3,
    lqip: '',
    featured: false,
    ...extra(i),
  }));
}

const labelsOf = (photos, terms = ['a', 'b', 'c']) => new Map(
  photos.map((photo) => [photo.id, labels(...terms)]),
);

/* ---------- 门槛 ---------- */

test('画面不足 9 张不出块：8 张没有，9 张才有', () => {
  const eight = monthPhotos(2026, 5, 8);
  assert.deepEqual(curateMonths({ items: eight, labelsById: labelsOf(eight) }), []);

  const nine = monthPhotos(2026, 5, 9);
  const months = curateMonths({ items: nine, labelsById: labelsOf(nine) });
  assert.equal(months.length, 1);
  assert.equal(months[0].key, '2026-05');
  assert.equal(months[0].count, 9);
  assert.equal(months[0].picks.length, MONTH_PICKS);
});

test('视频不算「画面」：9 个条目里有 4 条视频，只有 5 张照片，不出块', () => {
  const items = monthPhotos(2026, 9, 9, (i) => (i < 4
    ? { type: 'video', src: `v${i}.mp4`, duration: 12 }
    : {}));
  assert.equal(items.filter(isStill).length, 5);
  assert.deepEqual(curateMonths({ items, labelsById: labelsOf(items) }), []);
  assert.equal(monthKey(2026, 9), '2026-09');
});

test('折叠后不足 9 张也不出块：10 张里有 3 张同指纹，池子只剩 8', () => {
  const twin = { lqip: `data:image/webp;base64,${'x'.repeat(80)}AAAA` };
  const items = monthPhotos(2026, 11, 10, (i) => (i < 3 ? twin : {
    lqip: `data:image/webp;base64,${'y'.repeat(80)}${String(i).padStart(4, '0')}`,
  }));
  const months = curateMonths({ items, labelsById: labelsOf(items) });
  assert.deepEqual(months, [], '9 张是这个块的定义，凑不齐就不该假装有精选');
});

/* ---------- 去重折叠 ---------- */

test('近似折叠：同指纹只留一张，留下来的必须是分高的那张', () => {
  const print = `data:image/webp;base64,${'z'.repeat(90)}`;
  const items = monthPhotos(2026, 11, 9, (i) => (i === 0
    ? { lqip: print, featured: false }
    : i === 1 ? { lqip: print, featured: true } : { lqip: `data:image/webp;base64,${'w'.repeat(90)}${i}` }));
  const { picks } = pickMonth(items, { labelsById: labelsOf(items) });
  assert.ok(!picks.some((pick) => pick.id === 'p00'), '未标记的那张被折叠掉了');
  assert.ok(picks.some((pick) => pick.id === 'p01'), '人手动过 featured 的那张留下来');
  assert.equal(picks.length, 8, '9 张里折叠掉 1 张');
});

test('指纹判据弱就不折叠：短 lqip 与无 lqip 一律保留', () => {
  assert.equal(fingerprintOf({ lqip: 'data:image/webp;base64,short' }), '');
  assert.equal(fingerprintOf({}), '');
  assert.equal(fingerprintOf({ lqip: `data:image/webp;base64,${'q'.repeat(80)}` }).length, 24);

  const items = monthPhotos(2026, 11, 9, () => ({ lqip: 'data:image/webp;base64,short' }));
  const { picks, folded } = pickMonth(items, { labelsById: labelsOf(items) });
  assert.equal(picks.length, 9, '短 lqip 不当作指纹，一张都不合并');
  assert.deepEqual(folded, []);
});

/* ---------- 多样性 ---------- */

test('标签多样性：两张内容独有的照片不会被一堆同款挤掉', () => {
  const items = monthPhotos(2026, 7, 8);
  const byId = new Map(items.map((photo, i) => [
    photo.id,
    i < 6 ? labels('a', 'b', 'c') : labels(...(i === 6 ? ['x', 'y', 'z'] : ['u', 'v', 'w'])),
  ]));
  const { picks } = pickMonth(items, { labelsById: byId, slots: 5 });
  const ids = picks.map((pick) => pick.id);
  assert.equal(ids.length, 5);
  assert.ok(ids.includes('p06') && ids.includes('p07'), '两张独特的必须入选');
  assert.equal(ids.filter((id) => ['p00', 'p01', 'p02', 'p03', 'p04', 'p05'].includes(id)).length, 3);
});

test('多样性惩罚有界：一张高分照片不会因为标签撞车被永远压住', () => {
  // 8 张同款低分 + 1 张同款但被标了 featured —— 惩罚最多 0.45，featured 的 +0.6 顶得住
  const items = monthPhotos(2026, 7, 9, (i) => ({ featured: i === 8 }));
  const byId = labelsOf(items, ['a', 'b', 'c']);
  const { picks } = pickMonth(items, { labelsById: byId, slots: 9 });
  assert.equal(picks.length, 9);
  assert.equal(picks[0].id, 'p08', 'featured 那张仍然排第一');
});

/* ---------- 分数与信号 ---------- */

test('清晰度取前三个标签的信度均值；没有标签就是 0，不编中位数', () => {
  assert.equal(clarityScore([]), 0);
  assert.equal(clarityScore(undefined), 0);
  const three = [
    { term: 'a', confidence: 1 },
    { term: 'b', confidence: 0.5 },
    { term: 'c', confidence: 0.9 },
    { term: 'd', confidence: 0.1 },
  ];
  assert.equal(topLabels(three).length, 3);
  assert.equal(Number(clarityScore(three).toFixed(3)), 0.8, '只取前三，0.1 那条不拉低均值');
  assert.equal(clarityScore([{ term: 'x', confidence: 9 }]), 1, '信度被夹到 0..1');
});

test('丰富度在 12 个词处饱和；比例展示带内 1、带外 0.5', () => {
  assert.equal(densityScore(labels(...Array.from({ length: 6 }, (_, i) => `t${i}`))), 0.5);
  assert.equal(densityScore(labels(...Array.from({ length: 30 }, (_, i) => `t${i}`))), 1);
  assert.equal(ratioFit(1.33), 1);
  assert.equal(ratioFit(0.5625), 1);
  assert.equal(ratioFit(4), 0.5, '极端长条裁进方格损失最大');
  assert.equal(ratioFit(undefined), 0.5);
  assert.equal(scoreOf({ ratio: 1.3 }, []), 0.2, '没有标签时只剩比例这一项');
});

/* ---------- 幂等 / 顺序无关 ---------- */

test('选片与输入顺序无关：打乱后重跑，id 序列完全相同', () => {
  const items = monthPhotos(2026, 11, 12, (i) => ({
    featured: i % 5 === 0,
    lqip: i % 4 === 0 ? `data:image/webp;base64,${'p'.repeat(80)}AA` : '',
  }));
  const byId = new Map(items.map((photo, i) => [photo.id, labels(`t${i % 3}`, `s${i % 5}`, 'common')]));
  const first = pickMonth(items, { labelsById: byId }).picks.map((pick) => pick.id);

  const shuffled = [...items].reverse();
  const second = pickMonth(shuffled, { labelsById: byId }).picks.map((pick) => pick.id);
  assert.deepEqual(second, first, '同一份清单、不同到达顺序 → 同一份精选');
});

test('产物幂等：同一 rev 重复构建，JSON 逐字节相同', () => {
  const items = monthPhotos(2026, 11, 10);
  const byId = labelsOf(items);
  const months = curateMonths({ items, labelsById: byId });
  const a = JSON.stringify(curationDocument({ rev: 'abcdef12', months }));
  const b = JSON.stringify(curationDocument({ rev: 'abcdef12', months: curateMonths({ items, labelsById: byId }) }));
  assert.equal(a, b);
});

/* ---------- 产物白名单 ---------- */

test('产物只带白名单字段：lqip / ratio / tags 一个都不许进', () => {
  const items = monthPhotos(2026, 11, 9, (i) => ({
    // 每张一个不同的指纹，否则九张会被折叠成一张（那属于门槛测试的事）
    lqip: `data:image/webp;base64,${'k'.repeat(90)}${String(i).padStart(3, '0')}`,
    tags: ['2026'],
    title: '不该出现',
  }));
  const months = curateMonths({ items, labelsById: labelsOf(items) });
  const json = JSON.stringify(curationDocument({ rev: 'abcdef12', months }));
  assert.ok(!json.includes('data:image'), 'lqip 是二进制图像，公开产物里不该有');
  assert.ok(!json.includes('ratio'));
  assert.ok(!json.includes('不该出现'));
  assert.ok(!json.includes('2026-11-'), '不出现任何日级日期');

  const doc = JSON.parse(json);
  assert.equal(doc.version, CURATION_VERSION);
  assert.equal(doc.rev, 'abcdef12');
  assert.deepEqual(Object.keys(doc).sort(), ['months', 'picks', 'rev', 'version']);
  assert.deepEqual(Object.keys(doc.months[0]).sort(), ['count', 'month', 'picks', 'sentence', 'year']);
});

test('顶层 picks 是各月并集且去重，给照片墙「精选」源直接用', () => {
  const may = monthPhotos(2026, 5, 9);
  const nov = monthPhotos(2026, 11, 9).map((photo) => ({ ...photo, id: `q${photo.id.slice(1)}` }));
  const byId = new Map([...labelsOf(may), ...labelsOf(nov)]);
  const months = curateMonths({ items: [...may, ...nov], labelsById: byId });
  const doc = curationDocument({ rev: 'abcdef12', months });
  assert.equal(doc.months.length, 2);
  assert.equal(doc.months[0].month, 11, '月份按时间倒序');
  assert.equal(doc.picks.length, 18);
  assert.equal(new Set(doc.picks).size, 18);
});

test('curationFor / isCurationUsable：版本对不上就不认这份产物', () => {
  const items = monthPhotos(2026, 11, 9);
  const doc = curationDocument({
    rev: 'abcdef12',
    months: curateMonths({ items, labelsById: labelsOf(items) }),
  });
  assert.ok(curationFor(doc, 2026, 11));
  assert.equal(curationFor(doc, 2026, 10), null);
  assert.equal(curationFor(doc, '2026', '11'), curationFor(doc, 2026, 11), '年月是数字还是字符串都认');

  assert.equal(isCurationUsable(doc), true);
  assert.equal(isCurationUsable({ ...doc, version: 99 }), false);
  assert.equal(isCurationUsable(null), false);
  assert.equal(isCurationUsable({ months: [] }), false);
});

test('labelsFromIndex：只认有 id、有 term 的条目', () => {
  const map = labelsFromIndex({
    items: [
      { id: 'a', labels: [{ term: 'shirt' }, { term: '' }, { nope: 1 }] },
      { id: 'b', labels: [] },
      { labels: [{ term: 'x' }] },
      null,
    ],
  });
  assert.deepEqual([...map.keys()], ['a', 'b']);
  assert.equal(map.get('a').length, 1);
  assert.equal(labelsFromIndex(null).size, 0);
});

/* ---------- 一句文案 ---------- */

test('句子规范化：单行、去引号、末尾不留句号、超长截断', () => {
  assert.equal(cleanSentence('  十一月\n有风。 '), '十一月 有风');
  assert.equal(cleanSentence(''), '');
  assert.equal(cleanSentence(null), '');
  assert.equal(cleanSentence('一'.repeat(60)).length, 48);
});

test('applySentences：拿不到句子就是 null，前端据此不渲染那一行', () => {
  const months = [{ key: '2026-11', year: 2026, month: 11, count: 9, picks: ['a'] }];
  const withSentence = applySentences(months, new Map([['2026-11', '风把树吹得乱响']]));
  assert.equal(withSentence[0].sentence, '风把树吹得乱响');

  const without = applySentences(months, new Map());
  assert.equal(without[0].sentence, null);
  assert.equal(curationDocument({ rev: 'abcdef12', months: without }).months[0].sentence, null);
});

/* ---------- 模型：没有凭据就什么都不做 ---------- */

test('没有凭据时不发请求、不抛错、产物照出', async () => {
  let called = 0;
  const writer = createWriter({
    config: null,
    fetchImpl: () => { called += 1; throw new Error('不该被调用'); },
    logger: () => {},
  });
  assert.equal(writer.enabled, false);
  const out = await writer.write('abcdef12', [{ key: '2026-11', facts: { count: 9 } }]);
  assert.equal(out.size, 0);
  assert.equal(called, 0, '没有凭据就一次请求都不能发');
});

test('半个配置等于没有配置；明文地址不收', () => {
  assert.equal(llmConfig({}), null);
  assert.equal(llmConfig({ ALBUM_LLM_ENDPOINT: 'https://x.test/v1', ALBUM_LLM_KEY: 'k' }), null);
  assert.equal(llmConfig({
    ALBUM_LLM_ENDPOINT: 'http://x.test/v1', ALBUM_LLM_KEY: 'k', ALBUM_LLM_MODEL: 'm',
  }), null, '构建机不该向明文地址发凭据');
  const ok = llmConfig({
    ALBUM_LLM_ENDPOINT: 'https://x.test/v1/chat', ALBUM_LLM_KEY: 'k', ALBUM_LLM_MODEL: 'm',
  });
  assert.deepEqual(ok, { endpoint: 'https://x.test/v1/chat', key: 'k', model: 'm' });
});

test('句子过筛：含数字（日期/时间）、网址、套话的一律不要', () => {
  assert.equal(sanitizeSentence('十一月拍的'), '十一月拍的');
  assert.equal(sanitizeSentence('11 月 23 日拍的'), '');
  assert.equal(sanitizeSentence('详见 https://example.com'), '');
  assert.equal(sanitizeSentence('这一段，走完了。'), '');
  assert.equal(sanitizeSentence('“风很大”'), '风很大');
});

test('模型返回里抠 JSON：前后有解释文字也能读', () => {
  assert.deepEqual(parseSentences('好的：[{"key":"2026-11","text":"风很大"}] 以上'), [
    { key: '2026-11', text: '风很大' },
  ]);
  assert.deepEqual(parseSentences('没有数组'), []);
  assert.deepEqual(parseSentences('[{"key":"a","text":""}]'), []);
  assert.deepEqual(parseSentences('[坏 JSON'), []);
});

test('接上模型时：一次批量调用，句子进 Map，缓存命中后不再请求', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'curation-cache-'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '[{"key":"2026-11","text":"风把树吹得乱响"}]' } }],
      }),
    };
  };
  const config = { endpoint: 'https://x.test/v1/chat', key: 'secret-key', model: 'm' };
  const writer = createWriter({ config, fetchImpl, cacheDir, logger: () => {} });
  assert.equal(writer.enabled, true);

  const jobs = [{ key: '2026-11', facts: { count: 9, words: ['衬衫'] } }];
  const first = await writer.write('abcdef12', jobs);
  assert.equal(first.get('2026-11'), '风把树吹得乱响');
  assert.equal(calls.length, 1);

  // 请求本身：凭据在头里，不在 URL 也不在 body
  assert.equal(calls[0].url, config.endpoint);
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key');
  assert.ok(!calls[0].init.body.includes('secret-key'), 'body 里不许出现凭据');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'm');
  assert.match(body.messages[0].content, /JSON/);
  assert.match(body.messages[1].content, /2026-11/);

  // 缓存落盘，新进程（新 writer）直接读缓存，不重复计费
  const saved = JSON.parse(await readFile(path.join(cacheDir, `abcdef12.v${PROMPT_VERSION}.json`), 'utf8'));
  assert.equal(saved.items['2026-11'], '风把树吹得乱响');

  let secondCalls = 0;
  const offline = createWriter({
    config,
    fetchImpl: async () => { secondCalls += 1; throw new Error('不该再请求'); },
    cacheDir,
    logger: () => {},
  });
  const second = await offline.write('abcdef12', jobs);
  assert.equal(second.get('2026-11'), '风把树吹得乱响');
  assert.equal(secondCalls, 0, '同一 rev 的文案不该重复计费');

  await rm(cacheDir, { recursive: true, force: true });
});

test('模型不可用：非 2xx / 抛错 / 返回不是 JSON，都只丢句子', async () => {
  const config = { endpoint: 'https://x.test/v1/chat', key: 'k', model: 'm' };
  const jobs = [{ key: '2026-11', facts: {} }];

  const notOk = createWriter({
    config, fetchImpl: async () => ({ ok: false, status: 503 }), logger: () => {},
  });
  assert.equal((await notOk.write('rev1', jobs)).size, 0);

  const broken = createWriter({
    config, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('坏 JSON'); } }),
    logger: () => {},
  });
  assert.equal((await broken.write('rev2', jobs)).size, 0);

  const noNet = createWriter({
    config, fetchImpl: async () => { throw new Error('ECONNRESET'); }, logger: () => {},
  });
  assert.equal((await noNet.write('rev3', jobs)).size, 0);

  const emptyBatch = createWriter({ config, fetchImpl: async () => { throw new Error('不该调用'); }, logger: () => {} });
  assert.equal((await emptyBatch.write('rev4', [])).size, 0);
});

test('日志不带凭据与地址', async () => {
  const lines = [];
  const config = { endpoint: 'https://x.test/v1/chat', key: 'super-secret', model: 'm' };
  const writer = createWriter({
    config,
    fetchImpl: async () => { throw new Error('boom https://x.test/v1/chat?key=super-secret'); },
    logger: (line) => lines.push(line),
  });
  await writer.write('rev9', [{ key: '2026-11', facts: {} }]);
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    assert.ok(!line.includes('super-secret'));
    assert.ok(!line.includes('https://'));
  }
});

/* ---------- 门槛常量的意义 ---------- */

test('门槛与每月张数是常量，不是一个随手写死的数字', () => {
  assert.equal(MONTH_MIN_PHOTOS, 9);
  assert.equal(MONTH_PICKS, 9);
  assert.equal(CURATION_VERSION, 1);
});

/* ---------- 落盘：双写、幂等、什么都不写的情形 ---------- */

test('双写：rev 版与固定名逐字节相同，文件名带 rev', async () => {
  const { writeCurationArtifacts, monthFacts } = await import('../../build/curation-artifact.mjs');
  const dist = await mkdtemp(path.join(os.tmpdir(), 'curation-dist-'));
  const items = monthPhotos(2026, 11, 10);

  const doc = await writeCurationArtifacts({
    photos: items, rev: 'abc12345', dist, index: { items: [] }, warn: () => {}, log: () => {},
  });
  assert.ok(doc);
  const versioned = await readFile(path.join(dist, 'data', 'curation.abc12345.json'), 'utf8');
  const fixed = await readFile(path.join(dist, 'data', 'curation.json'), 'utf8');
  assert.equal(versioned, fixed, '两份内容必须一模一样，否则兜底路径会给出另一个版本');
  assert.deepEqual(JSON.parse(fixed), doc);

  // 幂等：同一 rev 重复构建，字节相同
  await writeCurationArtifacts({
    photos: items, rev: 'abc12345', dist, index: { items: [] }, warn: () => {}, log: () => {},
  });
  assert.equal(await readFile(path.join(dist, 'data', 'curation.json'), 'utf8'), fixed);

  await rm(dist, { recursive: true, force: true });
});

test('一个块都凑不齐时一个文件都不写', async () => {
  const { writeCurationArtifacts } = await import('../../build/curation-artifact.mjs');
  const dist = await mkdtemp(path.join(os.tmpdir(), 'curation-dist-'));
  const warnings = [];
  const items = monthPhotos(2026, 11, 8); // 差一张

  const doc = await writeCurationArtifacts({
    photos: items, rev: 'abc12345', dist, index: { items: [] }, warn: (line) => warnings.push(line), log: () => {},
  });
  assert.equal(doc, null);
  await assert.rejects(readFile(path.join(dist, 'data', 'curation.json'), 'utf8'));
  assert.ok(warnings.some((line) => line.includes('凑齐 9 张')));

  await rm(dist, { recursive: true, force: true });
});

test('没有索引也照写：只是没了清晰度与多样性这两项', async () => {
  const { writeCurationArtifacts } = await import('../../build/curation-artifact.mjs');
  const dist = await mkdtemp(path.join(os.tmpdir(), 'curation-dist-'));
  const warnings = [];
  const items = monthPhotos(2026, 11, 9, (i) => ({ featured: i === 7 }));

  const doc = await writeCurationArtifacts({
    photos: items, rev: 'abc12345', dist, index: null, warn: (line) => warnings.push(line), log: () => {},
  });
  assert.equal(doc.months.length, 1);
  assert.equal(doc.months[0].picks.length, 9);
  assert.equal(doc.months[0].picks[0], 'p07', '没有标签时 featured 是唯一的强弱信号');
  assert.ok(warnings.some((line) => line.includes('没有语义索引')));
  assert.ok(warnings.some((line) => line.includes('没有配置模型凭据')));

  await rm(dist, { recursive: true, force: true });
});

test('模型给了句子就落进产物；没给就留 null，九张照发', async () => {
  const { writeCurationArtifacts } = await import('../../build/curation-artifact.mjs');
  const dist = await mkdtemp(path.join(os.tmpdir(), 'curation-dist-'));
  const items = monthPhotos(2026, 11, 9);

  const withModel = {
    enabled: true,
    write: async () => new Map([['2026-11', '风把树吹得乱响']]),
  };
  const doc = await writeCurationArtifacts({
    photos: items, rev: 'abc12345', dist, index: null, writer: withModel, warn: () => {}, log: () => {},
  });
  assert.equal(doc.months[0].sentence, '风把树吹得乱响');
  assert.equal(doc.months[0].picks.length, 9);

  const without = await writeCurationArtifacts({
    photos: items, rev: 'def67890', dist, index: null,
    writer: { enabled: false, write: async () => new Map() },
    warn: () => {}, log: () => {}, log: () => {},
  });
  assert.equal(without.months[0].sentence, null);
  assert.equal(without.months[0].picks.length, 9, '模型失败只丢句子');

  await rm(dist, { recursive: true, force: true });
});

test('给模型的事实只有张数与词频前六，且顺序确定', async () => {
  const { monthFacts } = await import('../../build/curation-artifact.mjs');
  const byId = new Map([
    ['a', [{ term: 'shirt', zh: '衬衫' }, { term: 'lake', zh: '湖水' }]],
    ['b', [{ term: 'shirt', zh: '衬衫' }]],
    ['c', [{ term: 'shirt', zh: '衬衫' }, { term: 'sky', zh: '天空' }]],
  ]);
  const facts = monthFacts({ picks: ['a', 'b', 'c'], count: 9 }, byId);
  assert.deepEqual(facts, { count: 9, words: ['衬衫', '天空', '湖水'] });
  assert.equal(JSON.stringify(facts).includes('shirt'), false, '只给中文词，不给内部 term');
});
