/**
 * 索引不可用时的降级 / Degradation when the index is unavailable.
 *
 * 只用 manifest 的公开 year/month/tags（及 title/caption 文案）做基础筛选，
 * 绝不发起第二次网络请求，也不假装语义命中（FR-02、契约 queryContract.fallback）。
 *
 * Baseline filtering uses only manifest public year/month/tags (plus
 * title/caption text): no second network call and no pretend semantic match
 * (FR-02, contract queryContract.fallback).
 */
import { INDEX_VERSION, projectResult, search } from './index.mjs';

/** 版本不符、rev 过期或缺 items 都判不可用 / stale or unusable index. */
export function isIndexUsable(index, { version = INDEX_VERSION, rev = '' } = {}) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.items)) return false;
  if (index.version && index.version !== version) return false;
  if (rev && index.rev && index.rev !== rev) return false;
  return true;
}

/** 基础筛选：年份/月份 + 中文词在 album/title/caption/tags 里的字面匹配。 */
export function fallbackSearch(parse, manifest, { page = 1, pageSize = 40 } = {}) {
  const p = Number.isInteger(page) && page >= 1 ? page : 1;
  const s = Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100 ? pageSize : 40;
  const words = parse.explanation
    .filter((entry) => ['term', 'synonym', 'color'].includes(entry.kind))
    .map((entry) => String(entry.input).toLowerCase());
  const photos = Array.isArray(manifest?.photos) ? manifest.photos : [];
  const matched = photos.filter((photo) => {
    if (parse.filters.year != null && photo.year !== parse.filters.year) return false;
    if (parse.filters.month != null && photo.month !== parse.filters.month) return false;
    if (words.length) {
      const haystack = [photo.album, photo.title, photo.caption, ...(photo.tags || [])]
        .join(' ').toLowerCase();
      // 降级路径同样 AND（FR-03）：多词时命中一个不算命中。
      // The degraded path ANDs as well.
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  }).sort((a, b) => (
    (b.year || 0) - (a.year || 0)
    || (b.month || 0) - (a.month || 0)
    || String(a.id).localeCompare(String(b.id))
  ));
  const start = (p - 1) * s;
  return {
    items: matched.slice(start, start + s).map((photo) => projectResult(photo, {}, {
      matchCount: 0, conditionCount: 0,
    })),
    page: p,
    pageSize: s,
    total: matched.length,
  };
}

/**
 * 编排：索引可用走 index.search，否则降级到 manifest 基础筛选。
 * 返回的 result 始终符合契约 search.result 形状；degraded/fromIndex 是编排元数据。
 *
 * Orchestrate: index search when usable, otherwise manifest-only fallback.
 * `result` always matches the contract search.result shape; degraded/fromIndex
 * are orchestration metadata.
 */
export function runSearch({
  index, parse, manifest, indexOptions = {}, page = 1, pageSize = 40,
} = {}) {
  if (isIndexUsable(index, indexOptions)) {
    return {
      result: search(index, parse, manifest, { page, pageSize }),
      fromIndex: true,
      degraded: false,
      explanation: parse.explanation,
    };
  }
  return {
    result: fallbackSearch(parse, manifest, { page, pageSize }),
    fromIndex: false,
    degraded: true,
    explanation: parse.explanation,
  };
}
