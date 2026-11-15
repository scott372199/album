/**
 * 每月策展产物的读取与索引（V6 T-22）/ Load and index the curation artifact.
 *
 * 不碰 DOM：选片在构建期已定死，浏览器只做「按 rev 找到产物、按年月取那 9 个 id」。
 * 产物缺失是**正常状态**：返回 null，不留空占位（FR-01）。首屏预算 120 KB 是硬
 * 门禁，所以这里只留生产代码用得到的导出。
 *
 * No DOM: selection is frozen at build time. A missing artifact is a normal state,
 * not an error — null, no placeholder. Only exports production code actually uses.
 */

import { monthKeyOf } from './month-strip.js';

export { monthKeyOf };

/** 与构建期同一个版本号：对不上就不认这份产物 */
export const CURATION_VERSION = 1;

/** 带 rev 的不可变地址；rev 为空时返回空串（直接走固定名） */
export function resolveCurationUrl(rev) {
  const clean = String(rev || '').trim();
  if (!/^[0-9a-f]{8,64}$/i.test(clean)) return '';
  return `data/curation.${clean}.json`;
}

/** 产物是否可用：版本对得上、有 months 数组 */
export function isCurationUsable(doc, { version = CURATION_VERSION } = {}) {
  return Boolean(doc)
    && typeof doc === 'object'
    && Number(doc.version) === Number(version)
    && Array.isArray(doc.months);
}

/**
 * 拉取产物。先按 `rev` 拿不可变的那份，没有再退到固定名（plan §5 的兜底路径）。
 * 两个都失败 → `null`，调用方照常渲染时间流。
 */
export async function loadCuration({ rev = '', fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const candidates = [];
  const versioned = resolveCurationUrl(rev);
  if (versioned) candidates.push(versioned);
  candidates.push(`data/curation.json?_=${now()}`);

  for (const url of candidates) {
    try {
      const response = await fetchImpl(url, { cache: 'no-cache' });
      if (!response || !response.ok) continue;
      const data = await response.json();
      if (isCurationUsable(data)) return data;
    } catch {
      // 这一份没有就试下一份；都不行就是没有
    }
  }
  return null;
}

/**
 * 索引成「年月键 → 这一块」。
 * 只保留 picks 全为字符串、月份合法的块：结构不对的块比没有块更糟。
 */
export function curationIndex(doc) {
  const index = new Map();
  if (!isCurationUsable(doc)) return index;
  for (const month of doc.months) {
    const key = monthKeyOf({ year: month?.year, month: month?.month });
    if (!key) continue;
    const picks = Array.isArray(month.picks) ? month.picks.filter((id) => typeof id === 'string' && id) : [];
    if (!picks.length) continue;
    const sentence = typeof month.sentence === 'string' ? month.sentence.trim() : '';
    index.set(key, {
      key,
      year: Number(month.year),
      month: Number(month.month),
      count: Number(month.count) || picks.length,
      picks,
      sentence,
    });
  }
  return index;
}

/**
 * 把 id 换成照片对象，保持选片顺序。
 * 清单里找不到的 id 直接丢掉：产物比清单旧的时候会出现这种情况（照片被换过），
 * 宁可这一块少一张，也不留一个点不开的空瓦片。
 */
export function pickPhotos(byId, picks) {
  if (!byId || !Array.isArray(picks)) return [];
  const out = [];
  for (const id of picks) {
    const photo = byId.get(id);
    if (photo) out.push(photo);
  }
  return out;
}
