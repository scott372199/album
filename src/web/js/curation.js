/**
 * 每月策展产物的读取与索引（V6 T-22）。不碰 DOM，产物缺失就返回 null，不留空占位。
 * Load/index the curation artifact. No DOM; a missing artifact means null.
 */

import { monthKeyOf } from './month-strip.js';
import { loadArtifact } from './data.js';


/** 与构建期同一个版本号：对不上就不认这份产物 */
export const CURATION_VERSION = 1;

/** 拉取产物：地址拼装与兜底顺序在 `data.js#loadArtifact` 里，这里只给出版本号 */
export function loadCuration({ rev = '', fetchImpl, now } = {}) {
  return loadArtifact('curation', { rev, version: CURATION_VERSION, fetchImpl, now });
}

/** 产物是否可用：版本对得上、有 months 数组 */
export function isCurationUsable(doc, { version = CURATION_VERSION } = {}) {
  return Boolean(doc)
    && typeof doc === 'object'
    && Number(doc.version) === Number(version)
    && Array.isArray(doc.months);
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
