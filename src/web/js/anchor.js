/**
 * 「回到上次位置」的纯逻辑 / Pure "resume where you left off" logic（V6 T-17，P-01）。
 *
 * 只存 `{year, month}` 两个整数：不存像素偏移。
 * 存像素的版本看着更精确，但照片增删、密度切换、窗口宽度变化都会让它指到
 * 一个已经不存在的位置；年月是内容锚点，永远落在有意义的地方。
 *
 * 隐私模式下 `localStorage` 会抛异常，所以读写都包着 try——存不了就当没这功能，
 * 浏览本身不受影响。
 *
 * Stores only {year, month}: pixel offsets go stale as soon as photos are added,
 * density changes or the window resizes.
 */

export const ANCHOR_KEY = 'album.anchor';

/** 写进存储的最小形态；无效输入返回空串（等于清除） */
export function serializeAnchor(anchor) {
  const year = Number(anchor?.year);
  const month = Number(anchor?.month);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return '';
  if (!Number.isInteger(month) || month < 1 || month > 12) return '';
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 读回来；任何脏数据都当成「没有记忆」，不抛错 */
export function parseAnchor(raw) {
  const match = /^(\d{4})-(\d{1,2})$/.exec(String(raw || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * 从「当前视口里可见的锚点」挑一个：取最后一个顶边已经越过参考线的。
 * `entries` 按文档顺序（年 → 月）排好，`top` 是相对视口顶部的像素值。
 * 参考线默认在视口上方 1/4 处——比顶边更贴近「我正在看哪一段」。
 *
 * Picks the last anchor whose top has crossed the reference line, which matches
 * "what am I actually looking at" better than the raw top edge.
 */
export function nearestAnchor(entries, referenceLine = 0) {
  const list = Array.isArray(entries) ? entries : [];
  let picked = null;
  for (const entry of list) {
    if (!Number.isFinite(entry?.top)) continue;
    if (entry.top <= referenceLine) picked = entry;
  }
  return picked;
}

/** 记忆能不能直接用：同一年月，且该位置在当前结果里确实存在 */
export function anchorExists(anchor, available) {
  if (!anchor) return false;
  return (Array.isArray(available) ? available : [])
    .some((entry) => entry.year === anchor.year && entry.month === anchor.month);
}
