import test from 'node:test';
import assert from 'node:assert/strict';
import { escalationThresholds } from '../../../scripts/lib/thresholds.mjs';

/**
 * 逐级降档序列的单测。
 *
 * 为什么值得单独测：这段算术决定往生产标签里写什么阈值。写错的后果不是
 * 报错，而是**静默写入低质量标签**，没人会发现。
 *
 * Worth testing on its own: this arithmetic decides which confidence is written
 * into production labels. A bug here does not throw — it silently writes
 * lower-quality labels.
 */

test('从生产阈值降到下限，含两端', () => {
  assert.deepEqual(escalationThresholds(70, 55, 5), [70, 65, 60, 55]);
  assert.deepEqual(escalationThresholds(70, 60, 5), [70, 65, 60]);
  assert.deepEqual(escalationThresholds(70, 70, 5), [70]);
});

test('下限高于起点时只给起点，不做反向升档', () => {
  assert.deepEqual(escalationThresholds(70, 80, 5), [70]);
});

test('step 非正时只给起点，不死循环', () => {
  assert.deepEqual(escalationThresholds(70, 55, 0), [70]);
  assert.deepEqual(escalationThresholds(70, 55, -5), [70]);
});

test('非法入参返回空序列或起点', () => {
  assert.deepEqual(escalationThresholds(NaN, 55, 5), []);
  assert.deepEqual(escalationThresholds('abc', 55, 5), []);
  assert.deepEqual(escalationThresholds(70, NaN, 5), [70]);
});

test('起点永远在序列里，且严格递减不重复', () => {
  for (const [from, floor, step] of [[70, 55, 5], [75, 55, 10], [70, 51, 7]]) {
    const seq = escalationThresholds(from, floor, step);
    assert.equal(seq[0], from, '起点必须在内，保证至少按生产阈值跑一次');
    assert.equal(new Set(seq).size, seq.length, '不得重复');
    for (let i = 1; i < seq.length; i += 1) {
      assert.ok(seq[i] < seq[i - 1], '必须严格递减');
      assert.ok(seq[i] >= floor, '不得低于下限');
    }
  }
});
