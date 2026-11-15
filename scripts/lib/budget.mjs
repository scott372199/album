/**
 * 体积预算的纯逻辑 / Pure size-budget helpers（V6 T-12）。
 *
 * 拆出来是为了能在 Node 里直接断言：排序、占比、超限判定都是纯函数，
 * 不需要真的去 gzip 一个 dist 目录。
 *
 * Split out so ordering, share and over-budget decisions are assertable without
 * touching a real `dist/`.
 */

/**
 * 128 KB：V6 的硬预算。
 *
 * 2026-11-15 由 120 KB 上调（用户决定）。理由是这条门禁量的是 `dist/` 里
 * **未压缩的源码，含注释**——本仓库构建不剥注释，于是「写清楚为什么」和
 * 「省 400 字节」直接对撞，而真正该守的是首屏字节数不是注释字数。
 * 上调后仍有 ~8 KB 余量留给下一个功能；要再动它，先改 spec.md FR-14。
 *
 * Raised from 120 KB on 2026-11-15 (user decision): the gate measures
 * uncompressed source including comments, so documentation and byte count were
 * fighting each other. Change spec.md FR-14 first if this moves again.
 */
export const BUDGET_BYTES = 128 * 1024;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/**
 * 按体积降序并算占比。占比用于回答「超标是谁干的」——
 * 只看绝对值容易盯着自己的代码，其实往往是某个依赖。
 */
export function rank(items, total) {
  const snapshot = Array.isArray(items) ? items : [];
  return [...snapshot]
    .sort((a, b) => b.size - a.size)
    .map((item) => ({ ...item, share: total ? item.size / total : 0 }));
}

/** 一次完整的判定：总计、是否超限、超出多少、top-N 贡献者 */
export function summarize(items, budget = BUDGET_BYTES, topN = 5) {
  const measured = Array.isArray(items) ? items : [];
  const total = measured.reduce((sum, item) => sum + item.size, 0);
  return {
    total,
    budget,
    over: total > budget,
    overflow: Math.max(0, total - budget),
    remaining: Math.max(0, budget - total),
    top: rank(measured, total).slice(0, topN),
  };
}

/** 与上一次基线比增量；没有基线时返回空对象，不编造 0 */
export function deltas(measured, baseline) {
  const out = {};
  const files = baseline?.files;
  if (!files) return out;
  for (const item of measured) {
    if (typeof files[item.file] === 'number') out[item.file] = item.size - files[item.file];
  }
  return out;
}
