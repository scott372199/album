/**
 * 首屏选图注册表 / Hero selection registry (V6 T-11).
 *
 * V6 起首屏不再由前端轮播：HTML 里静态写死 `<img src="data/hero.webp">`，
 * 那张图由处理函数在发布时写进站点桶（见 src/server/processor/hero.mjs）。
 * 本模块因此只剩纯逻辑——构建期用 `buildHeroSections` 选图，其余函数是
 * 单元测试与未来复用点，全部 import-safe、不触碰 DOM。
 *
 * Since V6 the first screen is no longer a client-side carousel: the HTML
 * hard-codes `<img src="data/hero.webp">` and the processor writes that file
 * at publish time (see src/server/processor/hero.mjs). What is left here is
 * the pure registry — the build uses `buildHeroSections` to pick the shot,
 * everything else is covered by unit tests. No DOM access at all.
 */

/** 与 site.mjs 保持一致的字段白名单 / Mirrors the build-side whitelist */
export const HERO_SECTION_FIELDS = [
  'photo', 'eyebrow', 'title', 'subtitle', 'cta', 'target', 'duration',
];
export const HERO_MAX_SECTIONS = 8;
export const AUTO_MAX_SECTIONS = 3;
export const DEFAULT_DURATION = 6000;

/** 首屏自带文案：原创中文，不复制任何第三方素材或页面文字。 */
const AUTO_COPY = [
  {
    eyebrow: '时光档案',
    subtitle: '按时间、相册与标签，慢慢翻看这些瞬间。',
    cta: '浏览全部',
    target: '#catalog',
  },
  {
    eyebrow: '沿途风景',
    title: '把走过的路，收进画面。',
    subtitle: '山川、湖面与天空，按年份排成章节。',
    cta: '按年份浏览',
    target: '#catalog',
  },
  {
    eyebrow: '此刻',
    title: '一些不想忘记的光。',
    subtitle: '点开任意一张，回到那一天。',
    cta: '进入照片墙',
    target: '#wall-cta',
  },
];

const clampText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const safeAnchor = (value) => (
  typeof value === 'string' && value.trim().startsWith('#') ? value.trim().slice(0, 64) : ''
);

/**
 * 把一组原始 section 收敛成安全、有限、带白名单字段的列表。
 * 未知照片回退到 fallbackId；多余字段（含配置里可能夹带的路径/凭据）一律丢弃。
 *
 * Normalize raw sections: whitelist fields, cap the count, resolve unknown
 * photos to a fallback and drop every other key.
 */
export function normalizeHeroSections(raw, byId, { max = HERO_MAX_SECTIONS, fallbackId = '' } = {}) {
  if (!Array.isArray(raw)) return [];
  const has = (id) => byId instanceof Map ? byId.has(id) : Boolean(byId && byId[id]);
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const section = {};
    const wanted = typeof item.photo === 'string' ? item.photo.trim().slice(0, 64) : '';
    section.photo = wanted && has(wanted) ? wanted : fallbackId;
    const eyebrow = clampText(item.eyebrow, 120);
    const title = clampText(item.title, 80);
    const subtitle = clampText(item.subtitle, 160);
    const cta = clampText(item.cta, 40);
    const target = safeAnchor(item.target);
    if (eyebrow) section.eyebrow = eyebrow;
    if (title) section.title = title;
    if (subtitle) section.subtitle = subtitle;
    if (cta) section.cta = cta;
    if (target) section.target = target;
    const duration = Number(item.duration);
    section.duration = Number.isFinite(duration)
      ? Math.min(20000, Math.max(2000, Math.round(duration)))
      : DEFAULT_DURATION;
    if (!section.photo && !section.title) continue;
    out.push(section);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 无配置时，从 manifest 自动生成最多三个章节。
 * 优先：指定 hero → 精选/横图 → 最新；不足时按清单顺序补齐。
 *
 * With no config, generate up to three sections from the manifest, preferring
 * the configured hero, then featured/landscape shots, then the newest.
 */
export function autoHeroSections(manifest, { max = AUTO_MAX_SECTIONS } = {}) {
  const photos = Array.isArray(manifest?.photos) ? manifest.photos : [];
  if (!photos.length) return [];
  const site = manifest.site || {};
  const picked = [];
  const seen = new Set();
  const add = (photo) => {
    if (photo && !seen.has(photo.id)) { seen.add(photo.id); picked.push(photo); }
  };

  add(photos.find((photo) => photo.id === manifest.hero));
  for (const photo of photos) {
    if (picked.length >= max) break;
    if (photo.featured || Number(photo.ratio) >= 1.2) add(photo);
  }
  for (const photo of photos) {
    if (picked.length >= max) break;
    add(photo);
  }

  return picked.slice(0, max).map((photo, index) => {
    const copy = AUTO_COPY[index] || AUTO_COPY[AUTO_COPY.length - 1];
    return {
      photo: photo.id,
      eyebrow: copy.eyebrow,
      title: copy.title || site.title || '个人相册',
      subtitle: copy.subtitle || site.subtitle || '',
      cta: copy.cta,
      target: copy.target,
      duration: DEFAULT_DURATION,
    };
  });
}

/** 顶层编排：有配置用配置，没配置自动生成 / Config first, otherwise auto-generate */
export function buildHeroSections(manifest, { max = HERO_MAX_SECTIONS, autoMax = AUTO_MAX_SECTIONS } = {}) {
  const photos = Array.isArray(manifest?.photos) ? manifest.photos : [];
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const fallback = (photos.find((photo) => Number(photo.ratio) >= 1.2) || photos[0])?.id || '';
  const raw = Array.isArray(manifest?.heroSections) ? manifest.heroSections : [];
  if (!raw.length) return autoHeroSections(manifest, { max: autoMax });
  return normalizeHeroSections(raw, byId, { max, fallbackId: fallback });
}

/** 当前与下一张的索引（首屏只预加载这两张）/ Current + next indices to preload */
export function preloadPlan(sections, current = 0) {
  const total = sections.length;
  if (!total) return [];
  const index = ((current % total) + total) % total;
  if (total === 1) return [index];
  return [index, (index + 1) % total];
}

/** 复用已存在的多档 WebP，绝不裁切 / Reuse existing WebP derivatives, never crop */
export function srcsetForSection(photo) {
  if (!photo) return '';
  const parts = [];
  if (photo.grid) parts.push(`${photo.grid} 768w`);
  if (photo.view) parts.push(`${photo.view} 2048w`);
  if (!parts.length && photo.thumb) parts.push(`${photo.thumb} 320w`);
  if (!parts.length && photo.poster) parts.push(`${photo.poster} 768w`);
  return parts.join(', ');
}


/** 能力探测：低性能设备（核心数/内存/省流量） / Low-power device probe */
export function detectLowPower(nav = (typeof navigator !== 'undefined' ? navigator : {})) {
  const cores = Number(nav.hardwareConcurrency);
  const memory = Number(nav.deviceMemory);
  const saveData = Boolean(nav.connection && nav.connection.saveData);
  return (Number.isFinite(cores) && cores > 0 && cores <= 2)
    || (Number.isFinite(memory) && memory > 0 && memory <= 2)
    || saveData;
}

/** View Transitions 能力探测 / View Transitions capability probe */
export function viewTransitionsSupported(doc = (typeof document !== 'undefined' ? document : null)) {
  return Boolean(doc && typeof doc.startViewTransition === 'function');
}

/**
 * 动效档位。reduced-motion 或低性能 → 完全静态（不自动轮播、不隐藏内容）；
 * 不支持 View Transitions → 直接换图但内容始终可见。
 *
 * Motion profile. reduced-motion / low-power => fully static (no autoplay, no
 * hidden content). No View Transitions => instant swaps, content stays visible.
 */
export function motionProfile({ reducedMotion: rm = false, lowPower = false, viewTransitions = true } = {}) {
  const staticFallback = Boolean(rm || lowPower);
  return {
    staticFallback,
    animate: !staticFallback && Boolean(viewTransitions),
    autoplay: !staticFallback,
    reason: rm ? 'reduced-motion' : lowPower ? 'low-power' : !viewTransitions ? 'no-view-transitions' : 'full',
  };
}
