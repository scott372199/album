/**
 * V5 中文自然语言检索 / V5 Chinese natural-language search.
 *
 * 纯逻辑模块：不触碰 DOM，可直接被 Node 导入做断言。
 * 读取 S3 静态索引 `data/search-index.<rev>.json`（契约里的 shape），
 * 在浏览器本地检索、排序、分页；索引缺失/过期/加载失败时降级为 manifest
 * 本地筛选（年份/月份/标签）。结果始终是**已有的 manifest photo 对象**，
 * 复用现有渲染器、灯箱、照片墙与 URL state，不另建第二套模型。
 *
 * Pure module: no DOM, importable in Node. It reads the static S3 index, then
 * searches/sorts/paginates locally; a missing/stale/unloadable index degrades
 * to manifest-only filtering. Results are the existing manifest photo objects,
 * so the gallery/lightbox/wall/URL state are reused rather than rebuilt.
 */

/** 与 v5-contracts.json 一致 / Mirrors v5-contracts.json */
export const INDEX_VERSION = 'v5.1.0';

export const PUBLIC_FIELDS = [
  'album', 'caption', 'colors', 'explanation', 'id', 'labels',
  'month', 'paths', 'ratio', 'score', 'tags', 'title', 'year',
];

export const FORBIDDEN_FIELDS = [
  'accessKey', 'authorization', 'captureTimestamp', 'deviceSerial', 'gps',
  'originalFilename', 'originalKey', 'originalUrl', 'password', 'phone',
  'phoneNumber', 'rawExif', 'rawModelResponse', 'rawRekognitionResponse',
  'refreshToken', 'secret', 'sourcePath', 'terraformState', 'token',
];

/**
 * 中文词 → 规范词 + 类别。
 * value = [canonical, kind]，kind ∈ term|synonym|color。
 * 规范词用小写英文，和索引 labels[].term 对齐；中文展示词由 explanation.input 保留。
 *
 * Chinese phrase -> canonical term + kind. Canonical terms are lowercase and
 * align with the index `labels[].term`; `explanation.input` keeps the Chinese.
 */
export const LEXICON = {
  // 场景 / scene
  '湖水': ['lake', 'term'],
  '湖泊': ['lake', 'synonym'], '湖': ['lake', 'synonym'],
  '水面': ['lake', 'synonym'], '湖景': ['lake', 'synonym'],
  '山峰': ['mountain', 'term'],
  '山': ['mountain', 'synonym'], '群山': ['mountain', 'synonym'],
  '高山': ['mountain', 'synonym'], '雪山': ['mountain', 'synonym'],
  '山峦': ['mountain', 'synonym'],
  '蓝天': ['blue sky', 'term'],
  '青天': ['blue sky', 'synonym'], '天空': ['blue sky', 'synonym'],
  '晴空': ['blue sky', 'synonym'], '蓝天白云': ['blue sky', 'synonym'],
  // 物体 / object
  '汽车': ['car', 'term'],
  '轿车': ['car', 'synonym'], '小汽车': ['car', 'synonym'],
  '车子': ['car', 'synonym'], '车辆': ['car', 'synonym'],
  '摩托车': ['motorcycle', 'term'],
  '机车': ['motorcycle', 'synonym'], '摩托': ['motorcycle', 'synonym'],
  '电单车': ['motorcycle', 'synonym'],
  '衬衫': ['shirt', 'term'], '衬衣': ['shirt', 'synonym'],
  // 颜色 / color
  '红色': ['red', 'color'], '红': ['red', 'color'],
  '蓝色': ['blue', 'color'], '蓝': ['blue', 'color'],
  '绿色': ['green', 'color'], '绿': ['green', 'color'],
  '白色': ['white', 'color'], '白': ['white', 'color'],
  '黑色': ['black', 'color'], '黑': ['black', 'color'],
  '黄色': ['yellow', 'color'], '黄': ['yellow', 'color'],
};

const LEXICON_KEYS = Object.keys(LEXICON).sort((a, b) => b.length - a.length);

function scanChunk(chunk, ctx) {
  let i = 0;
  while (i < chunk.length) {
    const key = LEXICON_KEYS.find((candidate) => chunk.startsWith(candidate, i));
    if (!key) { i += 1; continue; }
    const [canonical, kind] = LEXICON[key];
    if (kind === 'color') {
      if (!ctx.filters.colors.includes(canonical)) ctx.filters.colors.push(canonical);
      ctx.explanation.push({ kind: 'color', input: key, mappedTo: canonical });
    } else {
      if (!ctx.terms.includes(canonical)) ctx.terms.push(canonical);
      ctx.explanation.push({ kind, input: key, mappedTo: canonical });
      if (!ctx.filters.tags.includes(canonical)) ctx.filters.tags.push(canonical);
    }
    i += key.length;
  }
}

/**
 * 解析自然语言查询 → 结构化条件 + 可解释 explanation。
 * 覆盖：湖水 / 山峰 / 蓝天 / 汽车 / 摩托车 / 红色衬衫 / 2025 年 /
 * 「2025 年的蓝天和汽车」。支持同义词、年月、颜色与组合。
 *
 * Parse a natural-language query into structured filters plus an explainable
 * `explanation` (kind/input/mappedTo). Handles the six sample terms, year,
 * month, color and combinations such as "2025 年的蓝天和汽车".
 */
export function parseQuery(raw, { page = 1, pageSize = 40 } = {}) {
  const original = String(raw || '').slice(0, 200);
  let rest = original.normalize('NFKC');
  const explanation = [];
  const terms = [];
  const filters = { year: null, month: null, colors: [], tags: [] };

  const yearMatch = rest.match(/(\d{4})\s*年/) || rest.match(/(?:^|\s)(\d{4})(?=\s|$)/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (year >= 1900 && year <= 2200) {
      filters.year = year;
      explanation.push({ kind: 'year', input: yearMatch[0].trim(), mappedTo: String(year) });
      rest = rest.replace(yearMatch[0], ' ');
    }
  }
  const monthMatch = rest.match(/(\d{1,2})\s*月/);
  if (monthMatch) {
    const month = Number(monthMatch[1]);
    if (month >= 1 && month <= 12) {
      filters.month = month;
      explanation.push({ kind: 'month', input: monthMatch[0].trim(), mappedTo: String(month) });
      rest = rest.replace(monthMatch[0], ' ');
    }
  }

  // 去掉语气词/连接词，再按最长前缀匹配词典
  // Strip filler words, then longest-prefix match against the lexicon
  rest = rest.replace(/[的和与及了的\s,，、;；]+/g, ' ');
  for (const chunk of rest.match(/[\u4e00-\u9fa5a-zA-Z0-9]+/g) || []) {
    scanChunk(chunk, { explanation, terms, filters });
  }

  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const safeSize = Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100 ? pageSize : 40;
  return { terms, filters, explanation, page: safePage, pageSize: safeSize };
}

/** 导出成契约里的 search.query 形状 / Export as the contract's search.query shape */
export function toQuery(parse, raw = '') {
  const filters = {};
  if (parse.filters.year != null) filters.year = parse.filters.year;
  if (parse.filters.month != null) filters.month = parse.filters.month;
  if (parse.filters.tags.length) filters.tags = parse.filters.tags.slice(0, 20);
  return {
    query: String(raw).slice(0, 200),
    filters,
    page: parse.page,
    pageSize: parse.pageSize,
  };
}

/** 索引文件名：rev 只接受十六进制哈希，避免路径注入 / Hash-only rev, no path injection */
export function indexUrl(rev) {
  const safe = /^[0-9a-f]{6,64}$/i.test(String(rev || '')) ? String(rev) : '';
  return safe ? `data/search-index.${safe}.json` : 'data/search-index.json';
}

/**
 * 索引是否可用：版本不符或与 manifest rev 不符都视为「过期」。
 * 缺 items 数组直接判不可用。
 *
 * Usability check: a version mismatch or a rev mismatch means stale; a missing
 * items array means unusable.
 */
export function isIndexUsable(index, { version = INDEX_VERSION, rev = '' } = {}) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.items)) return false;
  if (index.version && index.version !== version) return false;
  if (rev && index.rev && index.rev !== rev) return false;
  return true;
}

/** 递归找出禁止字段的路径（数组/对象都查）/ Recursively find forbidden field paths */
export function findForbidden(value, prefix = '', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, val] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_FIELDS.includes(key)) found.push(path);
    if (val && typeof val === 'object') findForbidden(val, path, found);
  }
  return found;
}

/**
 * 把拉取到的索引重建成只含契约字段的干净对象，顺手丢弃重复 id 与禁止字段。
 * 服务端本就不该写这些字段，前端再守一道。
 *
 * Rebuild the fetched index with contract fields only, dropping duplicate ids
 * and forbidden fields. The publisher should already exclude them; this is a
 * defensive second line.
 */
export function sanitizeIndex(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  const items = [];
  const seen = new Set();
  for (const item of raw.items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({
      id: item.id,
      year: Number(item.year) || 0,
      month: Number(item.month) || 0,
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [],
      labels: Array.isArray(item.labels)
        ? item.labels.filter((l) => l && typeof l.term === 'string').map((l) => ({
          term: String(l.term),
          zh: typeof l.zh === 'string' ? l.zh : '',
          kind: typeof l.kind === 'string' ? l.kind : '',
          confidence: Number(l.confidence) || 0,
        }))
        : [],
      colors: Array.isArray(item.colors) ? item.colors.filter((c) => typeof c === 'string') : [],
      source: typeof item.source === 'string' ? item.source : 'manifest',
    });
  }
  return {
    version: typeof raw.version === 'string' ? raw.version : INDEX_VERSION,
    rev: typeof raw.rev === 'string' ? raw.rev : '',
    vocabulary: raw.vocabulary && typeof raw.vocabulary === 'object' ? raw.vocabulary : {},
    items,
  };
}

/**
 * 公开投影：只保留 publicFields。用于任何需要对外暴露结果的场合，
 * 绝不会带上 thumb/grid/view、原始文件名或内部对象 key。
 *
 * Public projection restricted to `publicFields`; never carries private paths
 * or internal object keys.
 */
export function projectPublic(photo, extra = {}) {
  const src = { ...photo, ...extra };
  const out = {};
  for (const field of PUBLIC_FIELDS) {
    if (field === 'paths') {
      const paths = { ...(photo?.paths || {}), ...(extra.paths || {}) };
      if (photo && !Object.keys(paths).length) {
        if (photo.grid) paths.grid = photo.grid;
        if (photo.view) paths.view = photo.view;
        if (photo.thumb) paths.thumb = photo.thumb;
      }
      if (Object.keys(paths).length) out.paths = paths;
    } else if (src[field] !== undefined) {
      out[field] = src[field];
    }
  }
  return out;
}

function confidenceFor(item, term) {
  let best = 0;
  for (const label of item.labels || []) {
    if (label.term === term || label.zh === term) best = Math.max(best, Number(label.confidence) || 0);
  }
  return best;
}

function itemMatchesTerm(item, term) {
  if ((item.labels || []).some((label) => label.term === term || label.zh === term)) return true;
  return (item.tags || []).includes(term);
}

/** 单条打分的内部模型：匹配数 + 置信度和 / Internal per-item score */
function scoreItem(item, parse) {
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
      || (item.labels || []).some((label) => label.kind === 'color' && (label.term === color || label.zh === color));
    if (!hit) return null;
    matchCount += 1;
    confidenceSum += 1;
  }
  for (const term of parse.terms) {
    if (itemMatchesTerm(item, term)) {
      matchCount += 1;
      confidenceSum += confidenceFor(item, term);
    }
  }
  // 只有时间条件时，符合时间即相关；否则至少命中一个词才算相关
  // Time-only queries match every item of that period; otherwise at least one
  // term/color must hit.
  const needsSemantic = parse.terms.length > 0 || parse.filters.colors.length > 0;
  if (needsSemantic && matchCount <= (parse.filters.year != null ? 1 : 0) + (parse.filters.month != null ? 1 : 0)) {
    return null;
  }
  return { matchCount, confidenceSum };
}

function pageResult(matched, page, pageSize, extra) {
  const start = (page - 1) * pageSize;
  return {
    items: matched.slice(start, start + pageSize),
    matched,
    page,
    pageSize,
    total: matched.length,
    ...extra,
  };
}

/**
 * 索引检索：本地打分、按「匹配数 → 置信和 → 年份 → id」排序、分页。
 * 返回的 `matched` 是与入参 photos 相同的对象引用，供现有渲染器直接使用。
 *
 * Index search: local scoring, ranking (match count, confidence, year, id),
 * pagination. `matched` holds the very same photo object references so the
 * existing renderer can consume them unchanged.
 */
export function searchWithIndex(index, parse, photos, { page = 1, pageSize = 40 } = {}) {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const scored = [];
  for (const item of index.items || []) {
    const photo = byId.get(item.id);
    if (!photo) continue; // 索引条目必须存在于当前 manifest
    const score = scoreItem(item, parse);
    if (score) scored.push({ photo, ...score });
  }
  scored.sort((a, b) => (
    b.matchCount - a.matchCount
    || b.confidenceSum - a.confidenceSum
    || (b.photo.year || 0) - (a.photo.year || 0)
    || String(a.photo.id).localeCompare(String(b.photo.id))
  ));
  const matched = scored.map((entry) => entry.photo);
  return pageResult(matched, page, pageSize, {
    fromIndex: true, degraded: false, explanation: parse.explanation,
  });
}

/**
 * 索引不可用时的降级：manifest 本地按年份/月份/标签（及标题文案）筛选。
 * 绝不发起第二次网络请求，也不假装语义命中。
 *
 * Fallback when the index is unavailable: manifest-only filtering by
 * year/month/tags (plus title/caption text). No second network call, no
 * pretend semantic match.
 */
export function searchFallback(photos, parse, { page = 1, pageSize = 40 } = {}) {
  const words = parse.explanation
    .filter((entry) => ['term', 'synonym', 'color'].includes(entry.kind))
    .map((entry) => String(entry.input).toLowerCase());
  const matched = photos.filter((photo) => {
    if (parse.filters.year != null && photo.year !== parse.filters.year) return false;
    if (parse.filters.month != null && photo.month !== parse.filters.month) return false;
    if (words.length) {
      const haystack = [photo.album, photo.title, photo.caption, ...(photo.tags || [])]
        .join(' ').toLowerCase();
      if (!words.some((word) => haystack.includes(word))) return false;
    }
    return true;
  });
  return pageResult(matched, page, pageSize, {
    fromIndex: false, degraded: true, explanation: parse.explanation,
  });
}

/** 编排：索引可用走索引，否则降级 / Orchestrate: index path or fallback */
export function runSearch({ index, parse, photos, indexOptions = {}, page = 1, pageSize = 40 } = {}) {
  if (index && isIndexUsable(index, indexOptions)) {
    return searchWithIndex(index, parse, photos, { page, pageSize });
  }
  return searchFallback(photos, parse, { page, pageSize });
}
