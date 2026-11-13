import { readFile } from 'node:fs/promises';

/** site.json 的缺省值：不配置也能构建出一个合理的站点 */
export const DEFAULT_SITE = {
  title: '个人相册',
  subtitle: '',
  hero: 'latest-landscape',
  featured: [],
  heroSections: [],
  wall: { interval: 10, clock: true, night: { from: '22:00', to: '07:00' } },
  story: { pace: 'normal' },
};

/** hero section 允许出现在公开产物里的字段 / Public hero-section field whitelist */
export const HERO_FIELD_WHITELIST = [
  'photo', 'eyebrow', 'title', 'subtitle', 'cta', 'target', 'duration',
];
/** 最多八个 section / At most eight hero sections */
export const HERO_MAX_SECTIONS = 8;

const WALL_INTERVALS = new Set([5, 10, 20, 30]);
const PACES = new Set(['slow', 'normal', 'fast']);

function isTimeString(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 解析 site.json 的 heroSections。
 * 只抄白名单字段、截断到八个、把 target 限制成 #锚点、把 duration 夹到合理区间。
 * 任何多余字段（尤其是配置里可能混入的路径、凭据）都会被静默丢弃。
 *
 * Parse `site.json` heroSections: copy only whitelisted fields, cap at eight,
 * restrict `target` to hash anchors and clamp `duration`. Unknown keys are dropped.
 */
export function parseHeroSections(raw, warn = console.warn) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const section = {};
    if (typeof item.photo === 'string' && item.photo.trim()) section.photo = item.photo.trim().slice(0, 64);
    for (const key of ['eyebrow', 'title', 'subtitle', 'cta']) {
      if (typeof item[key] === 'string' && item[key].trim()) {
        section[key] = item[key].trim().slice(0, key === 'title' ? 80 : 120);
      }
    }
    if (typeof item.target === 'string' && item.target.trim()) {
      const target = item.target.trim();
      // 只允许站内锚点，避免公开产物携带外部地址或绝对路径
      // Hash anchors only: never let an external URL or absolute path into public artifacts
      if (target.startsWith('#') && target.length <= 64) section.target = target;
      else warn(`heroSections.target 只支持 #锚点，忽略 ${target}`);
    }
    const duration = Number(item.duration);
    if (Number.isFinite(duration)) {
      section.duration = Math.min(20000, Math.max(2000, Math.round(duration)));
    }
    // 无图也无标题的条目没有意义
    if (!section.photo && !section.title) continue;
    out.push(section);
    if (out.length >= HERO_MAX_SECTIONS) break;
  }
  if (raw.length > HERO_MAX_SECTIONS) {
    warn(`heroSections 最多 ${HERO_MAX_SECTIONS} 个，已截断（收到 ${raw.length} 个）`);
  }
  return out;
}

/**
 * 未知照片回退：section 指向的 id 不在当前照片里时换成首张横图（或首张）。
 * web 目标拿不到 photos/，此时原样透传，由运行时用真实 manifest 再校验一次。
 *
 * Unknown-photo fallback. The web target has no photos, so sections pass through
 * unchanged and the runtime re-validates them against the live manifest.
 */
export function resolveHeroSections(sections, photos, warn = console.warn) {
  if (!Array.isArray(sections) || !sections.length) return [];
  if (!Array.isArray(photos) || !photos.length) return sections;
  const ids = new Set(photos.map((photo) => photo.id));
  const fallback = (photos.find((photo) => Number(photo.ratio) >= 1.2) || photos[0])?.id || '';
  return sections
    .map((section) => {
      if (section.photo && ids.has(section.photo)) return section;
      warn(`heroSections.photo 未知，回退：${section.photo || '(空)'}`);
      return { ...section, photo: fallback };
    })
    .filter((section) => section.photo);
}

/**
 * 读取 site.json 并收敛成完整配置。
 * 任何非法字段都退回默认值并给出警告，绝不让构建因为一个手误的配置失败。
 */
export async function loadSite(file, warn = console.warn) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`site.json 解析失败，使用默认配置：${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};

  const wall = raw.wall && typeof raw.wall === 'object' ? raw.wall : {};
  const story = raw.story && typeof raw.story === 'object' ? raw.story : {};
  const night = wall.night && typeof wall.night === 'object' ? wall.night : {};

  if (wall.interval !== undefined && !WALL_INTERVALS.has(Number(wall.interval))) {
    warn(`site.wall.interval 只支持 5/10/20/30，忽略 ${wall.interval}`);
  }
  if (story.pace !== undefined && !PACES.has(String(story.pace))) {
    warn(`site.story.pace 只支持 slow/normal/fast，忽略 ${story.pace}`);
  }

  return {
    title: asString(raw.title, DEFAULT_SITE.title),
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : '',
    hero: asString(raw.hero, DEFAULT_SITE.hero),
    featured: Array.isArray(raw.featured)
      ? raw.featured.filter((item) => typeof item === 'string' && item.trim()).map((s) => s.trim())
      : [...DEFAULT_SITE.featured],
    heroSections: parseHeroSections(raw.heroSections, warn),
    wall: {
      interval: WALL_INTERVALS.has(Number(wall.interval))
        ? Number(wall.interval)
        : DEFAULT_SITE.wall.interval,
      clock: asBoolean(wall.clock, DEFAULT_SITE.wall.clock),
      night: {
        from: isTimeString(night.from) ? night.from : DEFAULT_SITE.wall.night.from,
        to: isTimeString(night.to) ? night.to : DEFAULT_SITE.wall.night.to,
      },
    },
    story: {
      pace: PACES.has(String(story.pace)) ? String(story.pace) : DEFAULT_SITE.story.pace,
    },
  };
}

/**
 * hero 选图：指定 id 优先；'latest-landscape' 取最新一张横图；
 * 没有横图才退回最新一张。竖向照片也允许，只是版式会上下留底色。
 */
export function resolveHero(site, photos) {
  if (!photos.length) return '';
  const wanted = String(site.hero || '').trim();
  if (wanted && wanted !== 'latest-landscape' && photos.some((p) => p.id === wanted)) {
    return wanted;
  }
  const landscape = photos.find((p) => p.ratio >= 1.2);
  return (landscape || photos[0]).id;
}

/**
 * 精选集：支持照片 id 与 `album:<相册名>` 两种写法。
 * 缺省时按时间倒序取最新几张，并跳过 hero，避免首屏同一张照片出现两次。
 */
export function resolveFeatured(site, photos, { hero = '', limit = 3 } = {}) {
  const picked = new Set();
  for (const token of site.featured) {
    if (token.startsWith('album:')) {
      const name = token.slice('album:'.length).trim();
      for (const photo of photos) if (photo.album === name) picked.add(photo.id);
    } else if (photos.some((p) => p.id === token)) {
      picked.add(token);
    }
  }
  if (!picked.size) {
    const newestFirst = [...photos].sort((a, b) => b.year - a.year || b.month - a.month);
    for (const photo of newestFirst) {
      if (photo.id === hero) continue;
      picked.add(photo.id);
      if (picked.size >= limit) break;
    }
    // 照片不足时兜底：至少留一张
    if (!picked.size && photos.length) picked.add(photos[0].id);
  }
  return picked;
}
