/**
 * V5 静态索引：构建 / 合并 / 校验 / 检索 / 排序 / 分页。
 * V5 static index: build / merge / validate / search / rank / paginate.
 *
 * 索引的唯一真相是 manifest：year/month/tags 一律取自 manifest 的公开字段，
 * 识别结果只补充 labels/colors/source。这样 id 必然存在、时间字段不会被伪造，
 * 且识别失败时照片仍带 source=manifest 条目，基础筛选可用。
 *
 * The manifest is the single source of truth: year/month/tags come only from
 * its public fields, while recognition adds labels/colors/source. Every id
 * therefore exists in the manifest, time fields cannot be forged, and a
 * recognition failure still leaves a source=manifest entry for baseline filters.
 *
 * 结果只含契约 publicFields；索引条目拒绝重复 id 与非单 float 的置信度。
 * Results contain only contract publicFields; duplicate ids and non-float
 * confidences are rejected.
 */
import {
  CONTRACT, PUBLIC_FIELDS, findForbidden,
} from '../v5/correlation.mjs';
import {
  normalizeLabels, LABEL_KINDS, isFiniteConfidence,
} from '../recognition/provider.mjs';
import { vocabularySnapshot, zhForTerm } from './vocabulary.mjs';

export const INDEX_VERSION = CONTRACT.version;
export const ITEM_FIELDS = ['id', 'year', 'month', 'tags', 'labels', 'colors', 'source'];
export const LABEL_FIELDS = ['term', 'zh', 'kind', 'confidence'];
export const SOURCES = ['rekognition', 'manifest', 'manual'];
export const RANKING = CONTRACT.queryContract.ranking;

/**
 * EmbeddingPort 占位：只定义端口，本轮不实现（D-5：S3 静态索引，无需向量库）。
 * 后续若引入 embedding，只需替换这个 adapter，不改检索契约。
 *
 * Placeholder port only, deliberately not implemented (D-5: static S3 index,
 * no vector store). A future embedding adapter replaces it without changing
 * the search contract.
 */
export class EmbeddingPort {
  // eslint-disable-next-line class-methods-use-this
  async embed() {
    throw new Error(
      'EmbeddingPort 尚未实现 / EmbeddingPort is a placeholder, not implemented',
    );
  }
}

export function manifestPhotoIds(manifest) {
  return new Set(
    (Array.isArray(manifest?.photos) ? manifest.photos : [])
      .map((photo) => photo?.id)
      .filter((id) => typeof id === 'string' && id),
  );
}

export function assertNoDuplicateIds(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item?.id)) {
      throw new Error(`索引条目重复 id / duplicate index id: ${item.id}`);
    }
    seen.add(item?.id);
  }
  return items;
}

/** 单条校验：字段白名单、id 存在、置信度是单个 float / single-float confidence. */
export function validateIndexItem(item, { ids = null } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('索引条目必须是对象 / index item must be an object');
  }
  for (const key of Object.keys(item)) {
    if (!ITEM_FIELDS.includes(key)) {
      throw new Error(`索引条目含非法字段 / invalid index item field: ${key}`);
    }
  }
  if (typeof item.id !== 'string' || !item.id) {
    throw new Error('索引条目缺少 id / index item missing id');
  }
  if (ids && !ids.has(item.id)) {
    throw new Error(`索引条目 id 不在 manifest / item id missing in manifest: ${item.id}`);
  }
  if (item.year !== undefined && (!Number.isInteger(item.year) || item.year < 1900 || item.year > 2200)) {
    throw new Error('索引条目 year 非法 / invalid index item year');
  }
  if (item.month !== undefined && (!Number.isInteger(item.month) || item.month < 1 || item.month > 12)) {
    throw new Error('索引条目 month 非法 / invalid index item month');
  }
  if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((t) => typeof t !== 'string'))) {
    throw new Error('索引条目 tags 必须是字符串数组 / tags must be strings');
  }
  if (item.colors !== undefined && (!Array.isArray(item.colors) || item.colors.some((c) => typeof c !== 'string'))) {
    throw new Error('索引条目 colors 必须是字符串数组 / colors must be strings');
  }
  if (item.source !== undefined && !SOURCES.includes(item.source)) {
    throw new Error('索引条目 source 非法 / invalid index item source');
  }
  if (item.labels !== undefined) {
    if (!Array.isArray(item.labels)) {
      throw new Error('索引条目 labels 必须是数组 / labels must be an array');
    }
    for (const label of item.labels) {
      if (!label || typeof label !== 'object' || Array.isArray(label)) {
        throw new TypeError('标签必须是对象 / label must be an object');
      }
      for (const key of Object.keys(label)) {
        if (!LABEL_FIELDS.includes(key)) {
          throw new Error(`标签含非法字段 / invalid label field: ${key}`);
        }
      }
      if (typeof label.term !== 'string' || !label.term
        || !LABEL_KINDS.includes(label.kind)
        || !isFiniteConfidence(label.confidence)) {
        throw new TypeError('标签形状非法或置信度不是单个 float / invalid label or confidence');
      }
    }
  }
  const hits = findForbidden(item);
  if (hits.length) {
    throw new Error(`索引条目含禁止字段 / forbidden fields in index item: ${hits.join(', ')}`);
  }
  return item;
}

export function validateIndexItems(items, manifest = null) {
  if (!Array.isArray(items)) {
    throw new TypeError('items 必须是数组 / items must be an array');
  }
  assertNoDuplicateIds(items);
  const ids = manifest ? manifestPhotoIds(manifest) : null;
  for (const item of items) validateIndexItem(item, { ids });
  return items;
}

export function validateIndex(index, manifest = null) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new TypeError('索引必须是对象 / index must be an object');
  }
  if (index.version !== INDEX_VERSION) {
    throw new Error(`索引版本不符 / index version mismatch: ${index.version}`);
  }
  validateIndexItems(index.items, manifest);
  const hits = findForbidden(index);
  if (hits.length) {
    throw new Error(`索引含禁止字段 / forbidden fields in index: ${hits.join(', ')}`);
  }
  return index;
}

/** 构建：以 manifest 为骨架，识别结果按 id 覆盖 labels/colors/source。 */
export function createIndex({ manifest, items = [], vocabulary = vocabularySnapshot() } = {}) {
  if (!manifest || !Array.isArray(manifest.photos)) {
    throw new TypeError('需要含 photos 的 manifest / manifest with photos is required');
  }
  validateIndexItems(items, manifest);
  const recognized = new Map(items.map((item) => [item.id, item]));
  const finalItems = manifest.photos.map((photo) => {
    const rec = recognized.get(photo.id);
    // 中文名在**索引构建期**回填，不依赖识别期的产物（V6 C-3）：
    // 词表更新后只需重建索引，不必重跑 Rekognition。
    // `zhForTerm()` 的兜底是 term 本身，所以「有 zh」不等于「有中文名」——
    // 判读覆盖率时要用「含汉字」而不是「非空」（见 scripts/audit-terms.mjs）。
    //
    // The Chinese name is resolved at index-build time, not at recognition time,
    // so a vocabulary update only needs an index rebuild. `zhForTerm()` falls
    // back to the term itself, so a non-empty `zh` does not imply a real name.
    const labels = normalizeLabels(Array.isArray(rec?.labels) ? rec.labels : [])
      .map((label) => (label.zh ? label : { ...label, zh: zhForTerm(label.term) }));
    const colors = Array.isArray(rec?.colors)
      ? [...new Set(rec.colors.filter((color) => typeof color === 'string'))]
      : [];
    return {
      id: photo.id,
      year: photo.year,
      month: photo.month,
      tags: Array.isArray(photo.tags)
        ? photo.tags.filter((tag) => typeof tag === 'string') : [],
      labels,
      colors,
      // 识别失败/未识别 → source=manifest，基础筛选仍可用
      // Recognition failure or absence -> source=manifest for baseline filters
      source: rec ? (rec.source || 'rekognition') : 'manifest',
    };
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return validateIndex({ version: INDEX_VERSION, vocabulary, items: finalItems }, manifest);
}

/** 合并：同 id 覆盖（幂等 upsert），但单个数组内重复 id 直接拒绝。 */
export function mergeIndex(base, extraItems = [], manifest = null) {
  if (!base || !Array.isArray(base.items)) {
    throw new TypeError('需要已有索引 / an existing index is required');
  }
  validateIndexItems(base.items, manifest);
  validateIndexItems(extraItems, manifest);
  const merged = new Map(base.items.map((item) => [item.id, item]));
  // 同 id 以 extra 覆盖语义字段，未提供的时间/标签保留 base（来自 manifest）的值
  // Same id: extra overrides semantic fields; missing time/tags keep the
  // manifest-derived values from base.
  for (const item of extraItems) {
    merged.set(item.id, { ...(merged.get(item.id) || {}), ...item });
  }
  const items = [...merged.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return validateIndex({ ...base, items }, manifest);
}

/** 打分：命中数 + 置信度和；时间/颜色不匹配直接淘汰。 */
export function scoreItem(item, parse) {
  let matchCount = 0;
  let confidenceSum = 0;
  if (parse.filters.year != null) {
    if (item.year !== parse.filters.year) return null;
    matchCount += 1;
  }
  if (parse.filters.month != null) {
    if (item.month !== parse.filters.month) return null;
    matchCount += 1;
  }
  for (const color of parse.filters.colors) {
    const hit = (item.colors || []).includes(color)
      || (item.labels || []).some((label) => label.kind === 'color'
        && (label.term === color || label.zh === color));
    if (!hit) return null;
    matchCount += 1;
    confidenceSum += 1;
  }
  for (const term of parse.terms) {
    const matched = (item.labels || []).some((label) => label.term === term || label.zh === term)
      || (item.tags || []).includes(term);
    // 多词是**且**不是**或**（FR-03）：任一词未命中即淘汰。
    // 原来的 `if (!matched) continue` 得到的是并集，「湖水 汽车」会把
    // 2 张湖水和 3 张汽车一并返回，看着合理却是错的。
    //
    // Multiple terms are ANDed. The old `continue` produced a union, so a
    // two-word query returned the two result sets glued together.
    if (!matched) return null;
    matchCount += 1;
    const confidences = (item.labels || [])
      .filter((label) => label.term === term || label.zh === term)
      .map((label) => label.confidence);
    confidenceSum += confidences.length ? Math.max(...confidences) : 0;
  }
  // 时间条件与词/颜色条件都已在上面的循环里逐条淘汰，走到这里即命中。
  // Time and semantic conditions are already enforced above; surviving means a hit.
  return { matchCount, confidenceSum };
}

/** 确定性排序：命中数 desc → 置信度和 desc → year desc → id asc。 */
export function rankAndPage(scored, page, pageSize) {
  const ordered = [...scored].sort((a, b) => (
    b.matchCount - a.matchCount
    || b.confidenceSum - a.confidenceSum
    || (b.item.year || 0) - (a.item.year || 0)
    || String(a.item.id).localeCompare(String(b.item.id))
  ));
  const start = (page - 1) * pageSize;
  return { ordered, pageItems: ordered.slice(start, start + pageSize) };
}

/** 契约 search.result.items[].* 投影：只含公开的 8 个字段。 */
export function projectResult(photo, item, { matchCount = 0, conditionCount = 0 } = {}) {
  const paths = {};
  for (const key of ['thumb', 'grid', 'view']) {
    if (typeof photo[key] === 'string') paths[key] = photo[key];
  }
  const out = {
    id: photo.id,
    album: photo.album,
    year: photo.year,
    month: photo.month,
    ratio: Number(photo.ratio) > 0 ? Number(photo.ratio) : 1,
    tags: Array.isArray(photo.tags) ? photo.tags.filter((tag) => typeof tag === 'string') : [],
    paths,
  };
  const denom = Math.max(1, conditionCount);
  out.score = Number(Math.min(1, Math.max(0, matchCount / denom)).toFixed(4));
  return out;
}

/** 完整 publicFields 投影（展示层用），所有键都来自契约白名单。 */
export function projectPublic(photo, extra = {}) {
  const src = { ...photo, ...extra };
  const out = {};
  for (const field of PUBLIC_FIELDS) {
    if (field === 'paths') {
      const paths = { ...(extra.paths || {}) };
      if (!Object.keys(paths).length) {
        for (const key of ['thumb', 'grid', 'view']) {
          if (typeof photo?.[key] === 'string') paths[key] = photo[key];
        }
      }
      if (Object.keys(paths).length) out.paths = paths;
    } else if (src[field] !== undefined) {
      out[field] = src[field];
    }
  }
  return out;
}

/** 索引检索：只返回存在于当前 manifest 的条目 / only manifest-present ids. */
export function search(index, parse, manifest, { page = 1, pageSize = 40 } = {}) {
  const p = Number.isInteger(page) && page >= 1 ? page : 1;
  const s = Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100 ? pageSize : 40;
  const byId = new Map((manifest?.photos || []).map((photo) => [photo.id, photo]));
  const conditionCount = (parse.filters.year != null ? 1 : 0)
    + (parse.filters.month != null ? 1 : 0)
    + parse.filters.colors.length + parse.terms.length;

  // 没听懂时返回空集，不返回全量——否则「无法解读」会被伪装成「全部命中」。
  // 与前端 searchWithIndex 的守卫同源，一致性测试会盯住这条。
  // An uninterpretable query returns nothing, not everything, mirroring the web
  // guard; the parity test keeps the two in lockstep.
  const understood = parse.terms.length > 0 || parse.filters.colors.length > 0
    || parse.filters.year != null || parse.filters.month != null;
  if (!understood) {
    return { items: [], page: p, pageSize: s, total: 0 };
  }

  const scored = [];
  for (const item of index?.items || []) {
    const photo = byId.get(item.id);
    if (!photo) continue; // 索引条目必须存在于当前 manifest
    const score = scoreItem(item, parse);
    if (score) scored.push({ item, photo, ...score });
  }
  const { pageItems } = rankAndPage(scored, p, s);
  return {
    items: pageItems.map((entry) => projectResult(entry.photo, entry.item, {
      matchCount: entry.matchCount, conditionCount,
    })),
    page: p,
    pageSize: s,
    total: scored.length,
  };
}
