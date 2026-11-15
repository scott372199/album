import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wanderOrder, createWander, ageOf, weightOf,
} from '../js/wander.js';

/**
 * V6 T-26：随机漫游。
 *
 * 「感觉挺随机」不是可验收的性质。这里钉三件事：
 *   1. 一轮内不重复；
 *   2. 老照片命中率高于线性随机（权重 1/(岁数+1)）；
 *   3. 同种子同序列（否则前两条只能靠运气复现）。
 */

const photo = (id, year) => ({ id, year, month: 6, ratio: 1.5 });

/** 混合年代的池子：今年 60 张，5 年前 20 张 */
function pool() {
  const out = [];
  for (let i = 0; i < 60; i += 1) out.push(photo(`new${i}`, 2026));
  for (let i = 0; i < 20; i += 1) out.push(photo(`old${i}`, 2021));
  return out;
}

test('岁数与权重：今年 1.0，去年 0.5，五年前 1/6', () => {
  assert.equal(ageOf(photo('a', 2026), 2026), 0);
  assert.equal(ageOf(photo('a', 2025), 2026), 1);
  assert.equal(ageOf(photo('a', 2030), 2026), 0, '未来时间按 0 岁处理');
  assert.equal(weightOf(photo('a', 2026), 2026), 1);
  assert.equal(weightOf(photo('a', 2025), 2026), 0.5);
  assert.ok(Math.abs(weightOf(photo('a', 2021), 2026) - 1 / 6) < 1e-12);
  assert.ok(Math.abs(weightOf(photo('a', 2016), 2026) - 1 / 11) < 1e-12, '十年老照片权重 1/11');
});

test('一轮 20 个不重复', () => {
  const order = wanderOrder(pool(), { nowYear: 2026, seed: 42, limit: 20 });
  assert.equal(order.length, 20);
  assert.equal(new Set(order.map((p) => p.id)).size, 20);
});

test('整轮覆盖全部照片，且每张只出现一次', () => {
  const list = pool();
  const order = wanderOrder(list, { nowYear: 2026, seed: 7 });
  assert.equal(order.length, list.length);
  assert.equal(new Set(order.map((p) => p.id)).size, list.length);
});

/**
 * ⚠️ 已知矛盾（用户 2026-11-15 决定：照原文 `1/(岁数+1)` 上线，用真实老照片验收）。
 *
 * 这条测试不再宣称「老照片更常出现」——按原文公式恰恰相反。它的作用是把公式的
 * **可观测后果**量出来并钉住：合成夹具（今年 60 张 + 五年前 20 张）里，前 20 个
 * 老照片只占约 8%，而线性随机是 25%。真实语料的数量分布完全不同，结论以线上漫游为准。
 */
test('权重公式的可观测后果：老照片占比低于线性随机（已知矛盾，待真实语料判定）', () => {
  const list = pool();
  const oldShare = (seed) => {
    const head = wanderOrder(list, { nowYear: 2026, seed, limit: 20 });
    return head.filter((p) => p.id.startsWith('old')).length / 20;
  };

  let total = 0;
  for (let seed = 1; seed <= 40; seed += 1) total += oldShare(seed);
  const average = total / 40;

  assert.ok(average < 0.25, `老照片占 ${(average * 100).toFixed(0)}%，与 1/(岁数+1) 的方向不符`);
  assert.ok(average > 0, '老照片不能完全不出现');
});

test('同种子同序列；换种子换序列', () => {
  const list = pool();
  const a = wanderOrder(list, { nowYear: 2026, seed: 99 });
  const b = wanderOrder(list, { nowYear: 2026, seed: 99 });
  const c = wanderOrder(list, { nowYear: 2026, seed: 100 });
  assert.deepEqual(a.map((p) => p.id), b.map((p) => p.id));
  assert.notDeepEqual(a.map((p) => p.id).slice(0, 10), c.map((p) => p.id).slice(0, 10));
});

test('limit 只截断输出，不影响抽样', () => {
  const list = pool();
  const full = wanderOrder(list, { nowYear: 2026, seed: 3 }).slice(0, 20).map((p) => p.id);
  const cut = wanderOrder(list, { nowYear: 2026, seed: 3, limit: 20 }).map((p) => p.id);
  assert.deepEqual(cut, full);
});

test('空池子返回空数组，不抛错', () => {
  assert.deepEqual(wanderOrder([], { nowYear: 2026 }), []);
  assert.deepEqual(wanderOrder(null, { nowYear: 2026 }), []);
});

test('游标：一批一批取，跨轮才允许重复', () => {
  const list = pool();
  const wander = createWander({ photos: list, nowYear: 2026, seed: 11, size: 20 });

  const first = wander.take(20).map((p) => p.id);
  assert.equal(new Set(first).size, 20, '第一轮内不该重复');
  assert.equal(wander.round, 1);

  const second = wander.take(5).map((p) => p.id);
  assert.equal(wander.round, 2, '取完一轮才开新轮');
  assert.equal(second.length, 5);
});

test('游标：池子小于一轮时也能取完且不重复', () => {
  const small = [photo('a', 2026), photo('b', 2022), photo('c', 2019)];
  const wander = createWander({ photos: small, nowYear: 2026, seed: 5, size: 20 });
  const batch = wander.take(3).map((p) => p.id);
  assert.deepEqual([...batch].sort(), ['a', 'b', 'c']);
});
