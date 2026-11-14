/**
 * 逐级降档序列 / Threshold escalation ladder.
 *
 * 从生产阈值开始，按 step 递减，直到下限（含）。纯函数，便于单测——
 * 这段算术一旦写错，后果是往生产标签里写入错阈值，所以单独拎出来测。
 *
 * 几条边界约定：
 *   - 下限高于起点时，只给起点（不做「反向升档」）；
 *   - step <= 0 时只给起点（否则死循环）；
 *   - 起点永远在序列里，保证「至少按生产阈值跑一次」。
 *
 * A pure function so the arithmetic can be unit-tested: getting it wrong means
 * writing labels at the wrong confidence in production.
 */

export function escalationThresholds(from, floor, step = 5) {
  const start = Number(from);
  if (!Number.isFinite(start)) return [];
  const end = Number(floor);
  const by = Number(step);
  if (!Number.isFinite(end) || !Number.isFinite(by) || by <= 0 || end > start) return [start];

  const out = [];
  for (let t = start; t >= end; t -= by) out.push(t);
  // 起点必须在内；上面的循环天然满足，这里只防浮点意外
  if (out[0] !== start) out.unshift(start);
  return out;
}
