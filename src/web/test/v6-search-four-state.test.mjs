import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  INDEX_VERSION, parseQuery, runSearch, searchWithIndex, searchFallback, queryStatusOf,
} from '../js/search.js';

/**
 * V6 FR-03：检索四态 + AND 语义 + 未识别词回传。
 *
 * 这条测试要挡住的是三类「看起来正常」的错：
 *   1. 未知词被静默丢掉 → 查询退化成「无条件」→ 返回全部照片，用户以为搜到了；
 *   2. 多词取并集 → 「湖水 汽车」返回 2 张湖水 + 3 张汽车，数字合理但语义错；
 *   3. 「没听懂」和「没搜到」共用一句空白文案，用户不知道下一步该做什么。
 *
 * Synthetic fixture so CI (which has no data/) stays green; a second block
 * re-checks the real corpus when data/search-index.json is present.
 */

const photo = (id, year = 2026, month = 11) => ({
  id, type: 'image', album: String(year), year, month, tags: [String(year)],
  title: '', caption: '', ratio: 1.5, lqip: 'data:image/webp;base64,AAAA',
  featured: false, thumb: `photos/${id}/thumb.webp`, grid: `photos/${id}/grid.webp`,
  view: `photos/${id}/view.webp`,
});

const label = (term, kind, confidence) => ({ term, zh: '', kind, confidence });
const item = (id, labels, year = 2026, month = 11) => ({
  id, year, month, tags: [String(year)], labels, colors: [], source: 'rekognition',
});

// p1 湖水 / p2 汽车 / p3 湖水+汽车 / p4 摩托车
const photos = [photo('p1'), photo('p2'), photo('p3'), photo('p4')];
const index = {
  version: INDEX_VERSION,
  items: [
    item('p1', [label('lake', 'scene', 0.9)]),
    item('p2', [label('car', 'object', 0.8)]),
    item('p3', [label('lake', 'scene', 0.9), label('car', 'object', 0.7)]),
    item('p4', [label('motorcycle', 'object', 0.6)]),
  ],
};

const run = (q, opts = {}) => runSearch({
  index, parse: parseQuery(q), photos, query: q, pageSize: 100, ...opts,
});

/* ---------------- 四态 / Four states ---------------- */

test('空查询是 idle，且不参与检索', () => {
  const r = run('');
  assert.equal(r.queryStatus, 'idle');
  assert.equal(queryStatusOf({ query: '   ', parse: parseQuery(''), total: 0 }), 'idle');
});

test('索引缺失是 degraded，并降级到 manifest 本地筛选', () => {
  const r = runSearch({
    index: null, parse: parseQuery('湖水'), photos, query: '湖水', pageSize: 100,
  });
  assert.equal(r.queryStatus, 'degraded');
  assert.equal(r.degraded, true);
  assert.equal(r.fromIndex, false);
});

test('未知词是 unknown-term：total=0，且原样回传未识别片段', () => {
  // 关键：**不能返回全部**。返回 47 张会让「没听懂」伪装成「全都命中」。
  const q = '大象';
  const parse = parseQuery(q);
  assert.deepEqual(parse.unmatched, ['大象']);
  assert.deepEqual(parse.terms, []);

  const r = run(q);
  assert.equal(r.queryStatus, 'unknown-term');
  assert.equal(r.total, 0, '未知词必须返回空集，而不是全量');
});

test('已知词但无照片是 no-match，与 unknown-term 区分开', () => {
  // 山峰在山词表里，只是这批照片没有 → 用户该看到「没拍过」，不是「不认识」
  const q = '山峰';
  const parse = parseQuery(q);
  assert.deepEqual(parse.terms, ['mountain'], '山峰应被词表识别');
  assert.deepEqual(parse.unmatched, []);

  const r = run(q);
  assert.equal(r.queryStatus, 'no-match');
  assert.equal(r.total, 0);
});

test('有命中是 ok', () => {
  const r = run('湖水');
  assert.equal(r.queryStatus, 'ok');
  assert.equal(r.total, 2);
});

/* ---------------- AND 语义 ---------------- */

test('多词取交集，不是并集', () => {
  const lake = run('湖水').total;
  const car = run('汽车').total;
  assert.equal(lake, 2);
  assert.equal(car, 2);

  const both = run('湖水 汽车');
  // 只有 p3 同时带 lake 和 car
  assert.equal(both.total, 1);
  assert.deepEqual(both.matched.map((p) => p.id), ['p3']);
  // 并集会是 3，交集必然 ≤ 两单词的较小值
  assert.ok(both.total <= Math.min(lake, car), '多词命中数不得超过两单词命中数的较小值');
});

test('降级路径同样是 AND', () => {
  // manifest 里 p3 同时有 2026 标签；降级只看标签/标题文本
  const parse = parseQuery('2026 湖水');
  const r = searchFallback(photos, parse, { pageSize: 100 });
  assert.equal(r.degraded, true);
  // 降级时 words 只含已识别的原词，p1/p3 的 tags 只有年份 → 无词命中 → 空
  assert.equal(r.total, 0);
});

/* ---------------- 时间与语义同时生效 ---------------- */

test('时间条件与语义条件叠加', () => {
  const parse = parseQuery('2026 年的湖水');
  assert.equal(parse.filters.year, 2026);
  assert.deepEqual(parse.terms, ['lake']);
  const r = run('2026 年的湖水');
  assert.equal(r.total, 2, '2026 年的湖水应为 p1、p3');

  // 年份不匹配时整批淘汰
  assert.equal(run('2025 年的湖水').total, 0);
  assert.equal(run('2025 年的湖水').queryStatus, 'no-match');
});

test('纯时间查询返回该时段的全部照片', () => {
  const r = run('2026 年');
  assert.equal(r.total, 4);
  assert.equal(r.queryStatus, 'ok');
});

/* ---------------- 真实语料（有 data/ 才跑） ---------------- */

const CORPUS = 'data/search-index.json';
test('真实语料：四态与 AND 在 47 张照片上的实测', { skip: !existsSync(CORPUS) }, () => {
  const raw = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const manifest = raw.items.map((i) => photo(i.id, i.year, i.month));
  const real = { version: INDEX_VERSION, items: raw.items };
  const go = (q) => runSearch({
    index: real, parse: parseQuery(q), photos: manifest, query: q, pageSize: 100,
  });

  // 「大象」不在语料里出现过，也不在词表里 → unknown-term
  assert.equal(go('大象').queryStatus, 'unknown-term');
  assert.equal(go('大象').total, 0);

  // 「摩托车」在词表里但语料没有 → no-match
  assert.equal(go('摩托车').queryStatus, 'no-match');
  assert.equal(go('摩托车').total, 0);

  // 交集：湖水与汽车的交集必然小于并集
  const lake = go('湖水').total;
  const car = go('汽车').total;
  const union = go('湖水').matched.filter((p) => go('汽车').matched.some((c) => c.id === p.id)).length;
  assert.equal(go('湖水 汽车').total, union, '交集应正好是重叠部分');
  assert.ok(go('湖水 汽车').total <= Math.min(lake, car));
});
