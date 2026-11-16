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
 * 132 KB：V6 的硬预算。
 *
 * 两次上调都是同一个原因：这条门禁量的是 `dist/` 里**未压缩的源码，含注释**，
 * 而本仓库构建不剥注释，于是「写清楚为什么」和「省 400 字节」直接对撞。
 *   · 2026-11-15 120 → 128 KB（用户决定），因为 T-22/T-23 又演成了删注释挤预算；
 *   · 2026-11-16 128 → 132 KB，这一期加了「月龄 + 每月一句手写文案」（约 2.1 KB）：
 *     文案本身放了 JSON（不计入），占预算的是月龄计算与首屏/章节的接线。
 *
 * **下次再要动它，先做构建时剥注释**——那不改变门禁含义，只改变被量的东西。
 *
 * Both raises come from the same cause: the gate measures uncompressed source
 * including comments. The next change should strip comments at build time
 * instead of moving the number again.
 */
export const BUDGET_BYTES = 132 * 1024;

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
