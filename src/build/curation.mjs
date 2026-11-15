/**
 * 每月策展（V6 T-22）/ Monthly curation.
 *
 * 规则选片，模型**不参与选片**（FR-07）。本模块是纯函数：进 manifest 条目与
 * 语义索引，出「哪几个月有块、每月哪 9 张」。落盘、写 S3、发布都不在这里，
 * 于是这份规则可以被本地构建、Lambda 发布者、单测三处共用而不会各自漂移。
 *
 * 三条选片信号在真实语料上先核对过，这里写清楚每个信号的**来源**，避免
 * 后来的人以为「清晰度」是算出来的像素指标：
 *
 *   1. 清晰度 → 用识别置信度当代理。模糊、过暗、失焦的片子，识别器给不出
 *      高置信标签。22 个标签的文件里有 1.0 / 0.97 / 0.80 / 0.71 这样的分层，
 *      是可见的间接量。**没有标签就没有分数**（视频恒无标签，故不进块）。
 *   2. 标签多样性 → 用索引里的 label.term。**不能用 manifest.tags**：实测
 *      47 张里每张 tags 只有 1 个（年份），拿它算多样性等于没算。
 *   3. 时间分散 → 公开产物里最细的时间就是「月」（不变量 6 禁止日级粒度），
 *      所以月内没有可分散的时间轴。**不做假动作**：退到「同一相册连续出现
 *      降权」这一层，并如实命名。
 *
 * Rule-based selection: the model never picks photos (FR-07). Pure functions in,
 * a document out; persistence lives elsewhere so the rules can be shared without
 * drifting. Each signal's provenance is documented above because "sharpness" is
 * a proxy here, not a measured pixel metric.
 */

import { isMotion } from '../web/js/wall-source.js';

/** 产物版本：字段改动时 +1，前端据此拒绝不认识的产物 */
export const CURATION_VERSION = 1;
/** 门槛：月内画面数少于 9 张不出块（FR-07） */
export const MONTH_MIN_PHOTOS = 9;
/** 每月 9 张（FR-07） */
export const MONTH_PICKS = 9;
/** 参与「清晰度」的标签个数：取置信度最高的几个，避免长尾把均值拉平 */
export const CLARITY_LABELS = 3;
/** 标签丰富度的饱和点：12 个以上不再加分 */
export const DENSITY_LABELS = 12;
/** 人手动过 featured 的照片加分 */
export const FEATURED_BONUS = 0.6;
/** 标签重合最多让出这么多分：有界，免得好照片永远排在后面 */
export const TAG_PENALTY = 0.45;
/** 与上一张同相册的代价（月内唯一还能用的「分散」轴） */
export const ALBUM_STREAK_PENALTY = 0.3;
/** 比例展示带：这个区间裁进九宫格损失可接受；极端长条只拿一半分 */
export const RATIO_BAND = [0.5, 2.0];
export const RATIO_OFF_BAND = 0.5;
/** 近似指纹：lqip 尾部取这么多字符 */
export const FINGERPRINT_LENGTH = 24;
/** lqip 短于此长度的不算指纹（宁可多放一张，也不误删） */
export const LQIP_MIN_LENGTH = 64;
/** 一句文案的长度上限（超过就是模型跑题了） */
export const SENTENCE_MAX = 48;
/** 顶层 picks 上限：给照片墙「精选」源用，不值得无限制地长 */
export const PICKS_MAX = 60;

/** 只认汉字标签：词表还没覆盖到的词仍会以英文 term 出现，那些不进文案 */
const CJK = /[\u4e00-\u9fa5]/;

/** 码点序：产物要跨平台逐字节一致，`localeCompare` 会因 ICU 不同而变 */
export function compareKeys(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 有画面的条目：动图/视频不在策展块里（它们没有识别标签，也没有静帧可比） */
export function isStill(item) {
  return Boolean(item) && !isMotion(item);
}

/** 月份的稳定键：`2026-09` */
export function monthKey(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return '';
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** 索引条目 → id → labels[] 的映射 */
export function labelsFromIndex(index) {
  const map = new Map();
  const items = Array.isArray(index?.items) ? index.items : [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string') continue;
    const labels = Array.isArray(item.labels) ? item.labels : [];
    map.set(item.id, labels.filter((label) => label && typeof label.term === 'string' && label.term));
  }
  return map;
}

/**
 * 一批照片里出现最多的中文词（给模型当事实用）。
 * 只认 `zh`：内部 term 是英文标识，没有理由进提示词。
 * 词频降序、同频按码点序——任何机器上都得到同一份提示词，这是幂等的前提。
 *
 * Most frequent Chinese words across a set of photos, for prompting. Chinese
 * labels only, and ordered without locale-sensitive comparison so the prompt is
 * identical on every machine.
 */
export function topWords(ids, labelsById, limit = 6) {
  const counts = new Map();
  for (const id of ids) {
    for (const label of labelsById.get(id) || []) {
      const zh = typeof label.zh === 'string' ? label.zh.trim() : '';
      // 词表没覆盖到的标签会以英文 term 出现（实测有 brown / grey / person），
      // 中文文案里混进英文词比少一个词更糟
      if (zh && CJK.test(zh)) counts.set(zh, (counts.get(zh) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareKeys(a[0], b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/** 按置信度降序取前 n 个标签，同分时按 term 码点序，保证确定性 */
export function topLabels(labels, n = CLARITY_LABELS) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => ({ term: label.term, confidence: Number(label.confidence) || 0 }))
    .sort((a, b) => b.confidence - a.confidence || compareKeys(a.term, b.term))
    .slice(0, n);
}

/**
 * 清晰度代理：前三个标签信度的均值（0..1）。
 * 没有索引、没有标签、置信度全是 0 → 0 分。**不编一个中位数出来**。
 */
export function clarityScore(labels) {
  const top = topLabels(labels);
  if (!top.length) return 0;
  const sum = top.reduce((acc, label) => acc + Math.min(1, Math.max(0, label.confidence)), 0);
  return sum / top.length;
}

/** 标签丰富度：去重后的词数 / 12，封顶 1 */
export function densityScore(labels) {
  if (!Array.isArray(labels)) return 0;
  const terms = new Set();
  for (const label of labels) if (label && typeof label.term === 'string' && label.term) terms.add(label.term);
  return Math.min(1, terms.size / DENSITY_LABELS);
}

/** 比例展示带：带内 1 分，带外只拿一半——防极端长条，不做审美判断 */
export function ratioFit(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return RATIO_OFF_BAND;
  return value >= RATIO_BAND[0] && value <= RATIO_BAND[1] ? 1 : RATIO_OFF_BAND;
}

/** 单张的结构分（不含多样性惩罚）：0 … 1 + FEATURED_BONUS */
export function scoreOf(item, labels) {
  if (!item) return 0;
  const base = 0.5 * clarityScore(labels)
    + 0.3 * densityScore(labels)
    + 0.2 * ratioFit(item.ratio);
  return Math.round((base + (item.featured ? FEATURED_BONUS : 0)) * 1e4) / 1e4;
}

/** 近似指纹：lqip 的尾段；短 lqip 一律返回空串（视作没有指纹） */
export function fingerprintOf(item) {
  const lqip = typeof item?.lqip === 'string' ? item.lqip : '';
  if (lqip.length < LQIP_MIN_LENGTH) return '';
  return lqip.slice(-FINGERPRINT_LENGTH);
}

/**
 * 去重折叠：指纹相同的只留分最高的一张。
 * 没有指纹的条目一律保留——判据弱的时候，宁可多放一张，也不把两件不同的事
 * 说成一件。这和 T-25 照片墙的连拍合并是同一条纪律。
 */
export function foldNearDuplicates(scored) {
  const winners = new Map();
  const kept = [];
  const folded = [];
  for (const entry of scored) {
    const print = fingerprintOf(entry.item);
    if (!print) {
      kept.push(entry);
      continue;
    }
    const seen = winners.get(print);
    if (!seen) {
      winners.set(print, entry);
      kept.push(entry);
      continue;
    }
    // 同指纹取高分者；分数相同时保留 id 较小的一张，保证同一输入同一结果
    const better = entry.score > seen.score
      || (entry.score === seen.score && compareKeys(entry.item.id, seen.item.id) < 0);
    if (better) {
      const at = kept.indexOf(seen);
      if (at >= 0) kept[at] = entry;
      winners.set(print, entry);
      folded.push({ kept: entry.item.id, dropped: seen.item.id });
    } else {
      folded.push({ kept: seen.item.id, dropped: entry.item.id });
    }
  }
  return { kept, folded };
}

/**
 * 月内选 9 张。
 *
 * 贪心：每次挑「结构分 − 多样性惩罚」最高的一张。惩罚有界（最多 TAG_PENALTY
 * + ALBUM_STREAK_PENALTY），所以一张真正突出的照片不会因为标签撞车被永远压住。
 *
 * Greedy selection on score minus bounded diversity penalties. The bound matters:
 * an unbounded penalty would let tag overlap bury a genuinely strong photo.
 */
export function pickMonth(items, { labelsById = new Map(), slots = MONTH_PICKS } = {}) {
  const scored = (Array.isArray(items) ? items : [])
    .filter(isStill)
    .map((item) => ({ item, score: scoreOf(item, labelsById.get(item.id) || []) }))
    .sort((a, b) => b.score - a.score || compareKeys(a.item.id, b.item.id));
  const { kept, folded } = foldNearDuplicates(scored);
  const pool = kept.sort((a, b) => b.score - a.score || compareKeys(a.item.id, b.item.id));

  // 只有一个相册时「同相册降权」对每张都是同一个常数，只会污染日志里的分数，
  // 不会改变顺序——所以干脆不启用。多相册才有话可说。
  // With a single album the streak penalty is a constant offset for everyone: it
  // cannot change the order, only make the reported scores misleading.
  const multiAlbum = new Set(pool.map((entry) => entry.item.album || '')).size > 1;

  const picked = [];
  const used = new Set();
  const usedTerms = new Set();
  let lastAlbum = '';

  while (picked.length < slots) {
    let best = null;
    let bestAdj = -Infinity;
    for (const entry of pool) {
      if (used.has(entry.item.id)) continue;
      const labels = labelsById.get(entry.item.id) || [];
      const terms = new Set(labels.map((label) => label?.term).filter(Boolean));
      let shared = 0;
      for (const term of terms) if (usedTerms.has(term)) shared += 1;
      // 重合度按「这张自己的词数」归一，长标签不会天然挨更重的罚
      const overlap = terms.size ? shared / Math.min(terms.size, 10) : 0;
      let penalty = TAG_PENALTY * Math.min(1, overlap);
      if (multiAlbum && lastAlbum && entry.item.album === lastAlbum) penalty += ALBUM_STREAK_PENALTY;
      const adj = entry.score - penalty;
      // 严格大于：同分时保留池子里更靠前（分更高 / id 更小）的那张
      if (adj > bestAdj + 1e-9) {
        bestAdj = adj;
        best = entry;
      }
    }
    if (!best) break;
    used.add(best.item.id);
    for (const label of labelsById.get(best.item.id) || []) {
      if (label?.term) usedTerms.add(label.term);
    }
    lastAlbum = best.item.album || '';
    picked.push({ id: best.item.id, score: best.score, adjusted: Math.round(bestAdj * 1e4) / 1e4 });
  }

  return { picks: picked, folded };
}

/**
 * 逐月策展。返回的月份**只含凑得齐 9 张的**：9 张是这个块的定义，
 * 折叠后不足 9 张就不出块，而不是出一个 7 张的「精选」。
 */
export function curateMonths({ items, labelsById = new Map(), minPhotos = MONTH_MIN_PHOTOS, slots = MONTH_PICKS } = {}) {
  const byMonth = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.id !== 'string') continue;
    const key = monthKey(item.year, item.month);
    if (!key) continue;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(item);
  }

  const months = [];
  for (const [key, list] of byMonth) {
    const stills = list.filter(isStill);
    if (stills.length < minPhotos) continue;
    const { picks } = pickMonth(stills, { labelsById, slots });
    if (picks.length < slots) continue;
    months.push({
      key,
      year: Number(list[0].year),
      month: Number(list[0].month),
      count: stills.length,
      picks: picks.map((pick) => pick.id),
    });
  }
  months.sort((a, b) => b.year - a.year || b.month - a.month);
  return months;
}

/** 把一句话规范成可公开的样子：单行、去首尾空白、限长、空的当没有 */
export function cleanSentence(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  // 句末不留句号：这一行是导读，不是一句话的结尾（与提示词里的要求一致）
  const clipped = flat.length > SENTENCE_MAX ? `${flat.slice(0, SENTENCE_MAX - 1)}…` : flat;
  return clipped.replace(/[。；;]$/, '');
}

/** 句子挂在月份上：拿不到就是 null，前端据此不渲染那一行 */
export function applySentences(months, sentences) {
  const table = sentences instanceof Map ? sentences : new Map(Object.entries(sentences || {}));
  return months.map((month) => {
    const sentence = cleanSentence(table.get(month.key));
    return sentence ? { ...month, sentence } : { ...month, sentence: null };
  });
}

/**
 * 产物：只抄白名单字段。
 * 顶层 `picks` 是各月精选的并集（给照片墙「精选」源），前端不必懂月份结构。
 */
export function curationDocument({ rev, months }) {
  const clean = (Array.isArray(months) ? months : [])
    .filter((month) => month && month.picks?.length)
    .map((month) => ({
      year: Number(month.year),
      month: Number(month.month),
      count: Number(month.count) || 0,
      picks: month.picks.map(String),
      sentence: cleanSentence(month.sentence) || null,
    }));

  const union = [];
  const seen = new Set();
  for (const month of clean) {
    for (const id of month.picks) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (union.length < PICKS_MAX) union.push(id);
    }
  }

  return {
    version: CURATION_VERSION,
    rev: String(rev || ''),
    months: clean,
    picks: union,
  };
}

/** 供前端与测试使用：从产物里取某个月 */
export function curationFor(document, year, month) {
  const key = monthKey(year, month);
  if (!key || !Array.isArray(document?.months)) return null;
  return document.months.find((item) => monthKey(item.year, item.month) === key) || null;
}

/** 产物是否可用：版本对得上、结构像个产物 */
export function isCurationUsable(document, { version = CURATION_VERSION } = {}) {
  return Boolean(document)
    && typeof document === 'object'
    && Number(document.version) === Number(version)
    && Array.isArray(document.months);
}
