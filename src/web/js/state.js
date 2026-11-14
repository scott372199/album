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
  // 'year' 是 V6 T-24 的年度页：复用 view 键，年份复用 year 键，不新增 hash 键
  if (view === 'album' || view === 'timeline' || view === 'year') snapshot.view = view;
  const mode = params.get('mode');
  // 'search' 复用既有 mode 键：搜索态是视图状态，不是新的一层覆盖物，也不新增 hash 键
  if (mode === 'story' || mode === 'wall' || mode === 'search') snapshot.mode = mode;
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

/**
 * 网格密度三档：修的是「一行想要多大」，不是「一行几张」。
 * 每行几张由宽度和 `maxPerRow` 决定，密度只改目标行宽——所以照片永远不会被裁切，
 * 只是行内会少放一张、整体变大。
 *
 * Density changes the target row width, not the crop: photos are never cut, the
 * row simply holds fewer of them at a larger size.
 */
export const DENSITY = { compact: 200, standard: 340, large: 520 };
export const DENSITY_KEY = 'album.density';

export function normalizeDensity(value) {
  return Object.hasOwn(DENSITY, value) ? value : 'standard';
}

export function layoutParams(containerWidth, density = 'standard') {
  const target = DENSITY[normalizeDensity(density)];
  if (containerWidth >= 1200) {
    return { gap: 20, target, maxPerRow: 3, featureMin: 320, featureMax: 780, featureEvery: 6 };
  }
  if (containerWidth >= 1024) {
    return { gap: 16, target, maxPerRow: 3, featureMin: 280, featureMax: 700, featureEvery: 6 };
  }
  if (containerWidth >= 768) {
    return { gap: 14, target, maxPerRow: 2, featureMin: 240, featureMax: 620, featureEvery: 5 };
  }
  return { gap: 10, target, maxPerRow: 2, featureMin: 180, featureMax: 520, featureEvery: 4 };
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

/* ---------------- 相册卡片 ---------------- */

/**
 * 相册卡片要说的三件事：时间跨度、封面、张数。
 *
 * 封面**不能用 `Math.random()`**——卡片在任何一次重绘（筛选、改密度、窗口缩放）
 * 都会重新渲染，随机封面的结果是「同一张卡片每次都在换脸」。
 * 这里用相册名的 FNV-1a 哈希取模选成员：同一个名字永远落在同一张。
 *
 * 哈希只做取模，不参与任何跨进程比较，所以不存在跨平台差异问题。
 *
 * The cover is chosen by a name hash, never at random: cards re-render on every
 * filter / density / resize, and a random cover would visibly reshuffle.
 */
export function hashOf(text) {
  let hash = 2166136261;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** `2024.3–2024.5`；单月时只写一个；跨年时两端都带年 */
export function formatAlbumSpan(members) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return '';
  const keys = list.map((photo) => (Number(photo.year) || 0) * 100 + (Number(photo.month) || 0));
  const min = Math.min(...keys);
  const max = Math.max(...keys);
  const label = (key) => `${Math.floor(key / 100)}.${key % 100}`;
  return min === max ? label(min) : `${label(min)}–${label(max)}`;
}

/**
 * 一个相册的卡片事实：封面（确定性）、张数、时间跨度。
 * 没有发布时间字段时**不编造**「最近更新」，只报张数（O-03 已定，不新增写路径）。
 */
export function albumSummary(album, members) {
  const list = Array.isArray(members) ? members : [];
  const count = Number.isFinite(album?.count) ? album.count : list.length;
  const pick = list.length ? list[hashOf(album?.name) % list.length] : null;
  return {
    name: album?.name || '',
    count,
    span: formatAlbumSpan(list),
    coverId: pick?.id || album?.cover || '',
    cover: pick || null,
  };
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
