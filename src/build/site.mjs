import { readFile } from 'node:fs/promises';

/** site.json 的缺省值：不配置也能构建出一个合理的站点 */
export const DEFAULT_SITE = {
  title: '个人相册',
  subtitle: '',
  hero: 'latest-landscape',
  featured: [],
  wall: { interval: 10, clock: true, night: { from: '22:00', to: '07:00' } },
  story: { pace: 'normal' },
};

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
 * 缺省时每年取最新一张，保证「大图锚点」不至于空着。
 */
export function resolveFeatured(site, photos) {
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
    const seenYear = new Set();
    for (const photo of photos) {
      if (seenYear.has(photo.year)) continue;
      seenYear.add(photo.year);
      picked.add(photo.id);
    }
  }
  return picked;
}
