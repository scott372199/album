/**
 * 状态与纯函数。
 * 本模块不触碰 DOM，可被 Node 直接 import 做断言。
 */

export const PLAY_INTERVAL = 4000;
export const PACE = { slow: 7000, normal: 5200, fast: 3600 };

export const state = {
  data: null,
  view: 'timeline',
  album: '',
  q: '',
  tag: '',
  year: '',
  month: '',
  mode: null,
  pace: 'normal',
  filtered: [],
  lightbox: {
    index: -1, timer: null, lastFocus: null, touchX: null,
    zoom: 1, panX: 0, panY: 0, pinch: null,
  },
  wall: { index: 0, interval: 10, clock: true, playing: true, night: null },
  story: { index: 0, chapter: 0, paused: false },
  // V5 语义索引运行状态；不写入 URL，查询本身复用已有的 q 字段。
  // suggestions 由 deriveSuggestions(index) 在索引载入时算一次，
  // 不随输入变化——按键重算在 3 万张照片上是不能接受的。
  // V5 semantic-index runtime state; not serialized into the URL — the query
  // keeps reusing the existing `q` field. Suggestions are derived once per
  // index load, not per keystroke.
  search: {
    status: 'idle', rev: '', index: null, error: '', suggestions: [],
  },
};

/** 搜索结果每页条数（契约 pageSize 上限 100）/ Page size for search results */
export const SEARCH_PAGE_SIZE = 40;

/* ---------------- URL hash ---------------- */

export function buildHash(snapshot = state) {
  const p = new URLSearchParams();
  if (snapshot.mode) p.set('mode', snapshot.mode);
  if (snapshot.view !== 'timeline') p.set('view', snapshot.view);
  if (snapshot.album) p.set('album', snapshot.album);
  if (snapshot.q) p.set('q', snapshot.q);
  if (snapshot.tag) p.set('tag', snapshot.tag);
  if (snapshot.year) p.set('year', snapshot.year);
  if (snapshot.month) p.set('month', snapshot.month);
  if (snapshot.pace && snapshot.pace !== 'normal') p.set('pace', snapshot.pace);
  const current = snapshot.filtered?.[snapshot.lightbox?.index];
  if (snapshot.lightbox?.index >= 0 && current) p.set('p', current.id);
  const value = p.toString();
  return value ? `#${value}` : '';
}

export function parseHashString(raw, snapshot) {
  const params = new URLSearchParams(String(raw).replace(/^#/, ''));
  snapshot.view = 'timeline';
  snapshot.album = '';
  snapshot.q = '';
  snapshot.tag = '';
  snapshot.year = '';
  snapshot.month = '';
  snapshot.pace = 'normal';
  snapshot.mode = null;
  if (snapshot.lightbox) snapshot.lightbox.index = -1;

  const view = params.get('view');
  if (view === 'album' || view === 'timeline') snapshot.view = view;
  const mode = params.get('mode');
  if (mode === 'story' || mode === 'wall') snapshot.mode = mode;
  const pace = params.get('pace');
  if (pace === 'slow' || pace === 'normal' || pace === 'fast') snapshot.pace = pace;

  snapshot.album = params.get('album') || '';
  snapshot.q = params.get('q') || '';
  snapshot.tag = params.get('tag') || '';
  const year = Number(params.get('year'));
  if (Number.isInteger(year) && year > 1900 && year < 2200) snapshot.year = String(year);
  const month = Number(params.get('month'));
  if (Number.isInteger(month) && month >= 1 && month <= 12) snapshot.month = String(month);
  return params.get('p') || '';
}

/* ---------------- 筛选与分组 ---------------- */

export function filterPhotos(list, criteria) {
  const q = String(criteria.q || '').toLowerCase();
  return list.filter((photo) => {
    if (criteria.album && photo.album !== criteria.album) return false;
    if (criteria.tag && !(photo.tags || []).includes(criteria.tag)) return false;
    if (criteria.year && photo.year !== Number(criteria.year)) return false;
    if (criteria.month && photo.month !== Number(criteria.month)) return false;
    if (q) {
      const haystack = [photo.title, photo.caption, photo.album, ...(photo.tags || [])]
        .join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export function groupByYearMonth(list) {
  const indexMap = new Map(list.map((photo, index) => [photo.id, index]));
  const years = new Map();
  for (const photo of list) {
    if (!years.has(photo.year)) years.set(photo.year, new Map());
    const months = years.get(photo.year);
    if (!months.has(photo.month)) months.set(photo.month, []);
    months.get(photo.month).push({ photo, index: indexMap.get(photo.id) });
  }
  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([month, items]) => ({ month, items })),
    }));
}

/* ---------------- 编辑式栅格 ---------------- */

export function layoutParams(containerWidth) {
  if (containerWidth >= 1200) {
    return { gap: 20, target: 340, maxPerRow: 3, featureMin: 320, featureMax: 780, featureEvery: 6 };
  }
  if (containerWidth >= 1024) {
    return { gap: 16, target: 300, maxPerRow: 3, featureMin: 280, featureMax: 700, featureEvery: 6 };
  }
  if (containerWidth >= 768) {
    return { gap: 14, target: 260, maxPerRow: 2, featureMin: 240, featureMax: 620, featureEvery: 5 };
  }
  return { gap: 10, target: 200, maxPerRow: 2, featureMin: 180, featureMax: 520, featureEvery: 4 };
}

function ratioOf(item) {
  const ratio = Number(item?.ratio);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function isMotion(item) {
  return item.type === 'video' || item.type === 'live' || item.type === 'animation';
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * 编辑式行模型：
 *  - feature：整行一张，宽度撑满，高度按比例并夹在 [featureMin, featureMax]
 *  - strip：2~maxPerRow 张，行高由总宽反解，使每张正好等比填满
 * 大图—小图交替由 featureEvery / featured / 视频 三种触发条件控制。
 */
export function computeEditorialRows(items, width, opts = {}) {
  const { gap, target, maxPerRow, featureMin, featureMax, featureEvery } = { ...layoutParams(width), ...opts };
  const rows = [];
  if (!items.length || !(width > 0)) return rows;

  let i = 0;
  let sinceFeature = 0;

  while (i < items.length) {
    const current = items[i];
    const mustFeature = i === 0
      || sinceFeature >= featureEvery
      || (current.featured === true && sinceFeature >= 3)
      || (isMotion(current) && sinceFeature >= 2);

    if (mustFeature) {
      const height = clamp(width / ratioOf(current), featureMin, featureMax);
      rows.push({ type: 'feature', items: [current], height });
      i += 1;
      sinceFeature = 0;
      continue;
    }

    const picked = [];
    let sumRatio = 0;
    while (i < items.length && picked.length < maxPerRow) {
      const candidate = items[i];
      if (picked.length > 0) {
        if (isMotion(candidate)) break;
        if (sinceFeature + picked.length >= featureEvery) break;
      }
      picked.push(candidate);
      sumRatio += ratioOf(candidate);
      i += 1;
      if ((width - gap * (picked.length - 1)) / sumRatio <= target) break;
    }

    const height = (width - gap * (picked.length - 1)) / sumRatio;
    if (picked.length === 1) {
      rows.push({
        type: 'feature',
        items: picked,
        height: clamp(height, featureMin, featureMax),
      });
      sinceFeature = 0;
    } else {
      rows.push({ type: 'strip', items: picked, height });
      sinceFeature += picked.length;
    }
  }

  return rows;
}

/* ---------------- 故事分章 ---------------- */

/**
 * 跨年时按年分章；单年时按月分章。
 * 章内按时间升序（叙事感），便于「从头讲一遍」。
 */
export function buildStory(list) {
  if (!list.length) return { chapters: [], byYear: false };
  const years = new Set(list.map((photo) => photo.year));
  const byYear = years.size >= 2;
  const sorted = [...list].sort((a, b) =>
    a.year - b.year || a.month - b.month || a.id.localeCompare(b.id));

  const map = new Map();
  for (const photo of sorted) {
    const key = byYear ? String(photo.year) : `${photo.year}-${String(photo.month).padStart(2, '0')}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: byYear ? `${photo.year}` : `${photo.year} · ${photo.month} 月`,
        items: [],
      });
    }
    map.get(key).items.push(photo);
  }

  return { chapters: [...map.values()], byYear };
}
