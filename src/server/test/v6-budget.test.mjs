import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_BYTES, formatBytes, rank, summarize, deltas,
} from '../../../scripts/lib/budget.mjs';

/**
 * V6 T-12：体积预算的纯逻辑。
 *
 * 门禁最怕两件事：① 超了却不报（漏），② 没超却报（吵，然后被人加 `|| true` 绕过）。
 * 这里把判定写成纯函数，就能在不动 dist 的情况下把边界钉住。
 *
 * The gate's two failure modes are "over budget but silent" and "under budget but
 * noisy"; both are pinned here without touching dist/.
 */

const file = (name, size) => ({ file: name, size });

test('预算就是 128 KB（2026-11-15 由 120 KB 上调，见 scripts/lib/budget.mjs）', () => {
  assert.equal(BUDGET_BYTES, 128 * 1024);
  assert.equal(formatBytes(BUDGET_BYTES), '128.0 KB');
});

test('刚好等于预算是通过，超 1 字节才算超', () => {
  const exact = summarize([file('a.js', BUDGET_BYTES)], BUDGET_BYTES);
  assert.equal(exact.over, false);
  assert.equal(exact.remaining, 0);
  assert.equal(exact.overflow, 0);

  const over = summarize([file('a.js', BUDGET_BYTES + 1)], BUDGET_BYTES);
  assert.equal(over.over, true);
  assert.equal(over.overflow, 1);
});

test('超限时报出超出多少，并给出 top-5 且降序', () => {
  // 用「相对预算」写，预算再调也不会让这条用例悄悄变成「没超」
  const items = [
    file('vendor.js', BUDGET_BYTES - 20 * 1024),
    file('app.js', 20 * 1024),
    file('style.css', 15 * 1024),
    file('tiny.js', 100),
  ];
  const result = summarize(items, BUDGET_BYTES);
  assert.equal(result.over, true);
  assert.equal(result.total, BUDGET_BYTES + 15 * 1024 + 100);
  assert.deepEqual(result.top.map((item) => item.file), ['vendor.js', 'app.js', 'style.css', 'tiny.js']);
  assert.equal(result.top.length, 4, '不足 5 个时不要补空位');
});

test('占比之和为 1，且单项占比与总量一致', () => {
  const items = [file('a.js', 300), file('b.js', 700)];
  const ranked = rank(items, 1000);
  assert.equal(ranked[0].file, 'b.js');
  assert.equal(ranked[0].share, 0.7);
  assert.equal(ranked.reduce((sum, item) => sum + item.share, 0), 1);
});

test('空产物不会算出 NaN（除以 0 要收敛）', () => {
  const result = summarize([], BUDGET_BYTES);
  assert.equal(result.total, 0);
  assert.equal(result.over, false);
  assert.deepEqual(result.top, []);
  assert.deepEqual(rank([], 0), []);
});

test('增量：没有基线时返回空对象，不编造 0', () => {
  const measured = [file('a.js', 500)];
  assert.deepEqual(deltas(measured, null), {});
  assert.deepEqual(deltas(measured, {}), {});
  assert.deepEqual(deltas(measured, { files: {} }), {});
});

test('增量：有基线时只报双方都有的文件', () => {
  const measured = [file('a.js', 520), file('b.js', 300)];
  const baseline = { total: 800, files: { 'a.js': 500, 'gone.js': 200 } };
  assert.deepEqual(deltas(measured, baseline), { 'a.js': 20 });
});

test('新出现的文件不报增量（基线里没有它，无从相减）', () => {
  const measured = [file('new.js', 900)];
  assert.deepEqual(deltas(measured, { files: { 'old.js': 100 } }), {});
});
