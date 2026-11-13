/**
 * V5 首页 hero 注册表 / V5 data-driven hero registry.
 *
 * 配置来自 manifest.heroSections（构建侧已做字段白名单与上限收敛）。
 * 没有配置时，从 manifest 自动生成最多三个章节。
 *
 * Config comes from `manifest.heroSections` (already whitelisted and capped by
 * the build). With no config, up to three sections are generated from the
 * manifest. The pure helpers below are import-safe in Node for unit tests;
 * only `initHero` touches the DOM.
 */

import { el, reducedMotion } from './ui.js';

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

export function sectionMedia(photo) {
  return photo?.view || photo?.grid || photo?.thumb || photo?.poster || '';
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

/* ------------------------------------------------------------------ */
/* DOM 装配 / DOM wiring                                               */
/* ------------------------------------------------------------------ */

/**
 * 挂载 hero。返回 { update, go, current, count, destroy }。
 * 首屏同步渲染第一张，不依赖任何动效完成，保证「首屏不得空白」。
 *
 * Mount the hero. The first section is rendered synchronously so the first
 * paint never waits on a transition.
 */
export function initHero(manifest, byId, options = {}) {
  const { onCta } = options;
  const doc = typeof document !== 'undefined' ? document : null;
  const stage = el('hero-stage');
  const media = el('hero-media');
  const mediaNext = el('hero-media-next');
  const eyebrow = el('hero-eyebrow');
  const title = el('site-title');
  const subtitle = el('site-subtitle');
  const cta = el('hero-cta');
  const controls = el('hero-controls');
  const dots = el('hero-dots');
  const prev = el('hero-prev');
  const next = el('hero-next');

  const profile = motionProfile({
    reducedMotion: reducedMotion.matches,
    lowPower: detectLowPower(),
    viewTransitions: viewTransitionsSupported(doc),
  });

  const local = {
    sections: [],
    byId: byId instanceof Map ? byId : new Map(),
    current: 0,
    timer: null,
    paused: false,
  };

  function fallbackPhoto() {
    for (const section of local.sections) {
      const photo = local.byId.get(section.photo);
      if (photo) return photo;
    }
    return null;
  }

  function setSrcset(node, photo) {
    if (!node) return;
    const set = srcsetForSection(photo);
    if (set) { node.srcset = set; node.sizes = '100vw'; }
    else { node.removeAttribute('srcset'); }
    const src = sectionMedia(photo);
    if (src) node.src = src;
    else node.removeAttribute('src');
    node.alt = photo?.title || '';
  }

  /** 预加载当前与下一张的 srcset / Preload current + next srcset */
  function preload(index) {
    const plan = preloadPlan(local.sections, index);
    const nextIndex = plan[1];
    const photo = nextIndex === undefined ? null : local.byId.get(local.sections[nextIndex]?.photo);
    setSrcset(mediaNext, photo);
    if (!doc) return;
    for (const node of [...doc.querySelectorAll('link[data-hero-preload]')]) node.remove();
    for (const i of plan) {
      const p = local.byId.get(local.sections[i]?.photo);
      const set = srcsetForSection(p);
      if (!set) continue;
      const link = doc.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.setAttribute('imagesrcset', set);
      link.setAttribute('imagesizes', '100vw');
      link.dataset.heroPreload = '1';
      doc.head.appendChild(link);
    }
  }

  function updateDots() {
    if (!dots) return;
    dots.replaceChildren();
    local.sections.forEach((section, index) => {
      const dot = doc.createElement('button');
      dot.type = 'button';
      dot.className = 'hero-dot';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-label', `第 ${index + 1} 个章节：${section.title || '照片'}`);
      dot.setAttribute('aria-selected', String(index === local.current));
      dot.classList.toggle('is-active', index === local.current);
      dot.addEventListener('click', () => go(index, { user: true }));
      dots.appendChild(dot);
    });
  }

  function renderCopy(section, siteTitle) {
    if (eyebrow) eyebrow.textContent = section.eyebrow || 'PHOTO ARCHIVE';
    if (title) title.textContent = section.title || siteTitle || '个人相册';
    if (subtitle) subtitle.textContent = section.subtitle || '';
    if (cta) {
      if (section.cta && section.target) {
        cta.textContent = section.cta;
        cta.setAttribute('href', section.target);
        cta.hidden = false;
      } else {
        cta.hidden = true;
        cta.removeAttribute('href');
      }
    }
  }

  function applyPhoto(photo, animate) {
    const run = () => setSrcset(media, photo);
    if (animate && profile.animate && doc && typeof doc.startViewTransition === 'function') {
      media.style.viewTransitionName = 'hero-media';
      try {
        const transition = doc.startViewTransition(() => {
          media.style.viewTransitionName = '';
          run();
        });
        transition.finished.finally(() => { media.style.viewTransitionName = ''; });
      } catch {
        media.style.viewTransitionName = '';
        run();
      }
    } else {
      run();
    }
  }

  function render(index, { animate = false, user = false } = {}) {
    const section = local.sections[index];
    if (!section) return;
    const siteTitle = manifest?.site?.title || '个人相册';
    const photo = local.byId.get(section.photo) || fallbackPhoto();
    renderCopy(section, siteTitle);
    applyPhoto(photo, animate);
    const ratio = Number(photo?.ratio);
    const hero = doc?.querySelector?.('.hero');
    hero?.style.setProperty('--hero-ratio', String(Number.isFinite(ratio) && ratio > 0 ? ratio : 1.5));
    local.current = index;
    updateDots();
    preload(index);
    if (user) schedule();
  }

  function go(index, { user = false } = {}) {
    const total = local.sections.length;
    if (!total) return;
    const target = ((index % total) + total) % total;
    render(target, { animate: true, user });
  }

  function schedule() {
    clearTimeout(local.timer);
    if (!profile.autoplay || local.paused || local.sections.length < 2) return;
    const section = local.sections[local.current];
    const duration = Number(section?.duration) || DEFAULT_DURATION;
    local.timer = setTimeout(() => go(local.current + 1), duration);
  }

  function wireControls() {
    if (prev) prev.addEventListener('click', () => go(local.current - 1, { user: true }));
    if (next) next.addEventListener('click', () => go(local.current + 1, { user: true }));
    if (cta) cta.addEventListener('click', (event) => {
      const target = cta.getAttribute('href') || '';
      if (!target.startsWith('#')) return;
      event.preventDefault();
      const node = doc.querySelector(target);
      if (node) node.scrollIntoView({ behavior: profile.staticFallback ? 'auto' : 'smooth' });
      if (typeof onCta === 'function') onCta(target);
    });

    // 键盘：左右箭头切换章节 / Keyboard: left/right arrows switch sections
    if (stage) stage.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(local.current - 1, { user: true }); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(local.current + 1, { user: true }); }
    });

    // 触摸：横向滑动切换 / Touch: horizontal swipe switches sections
    let startX = null;
    if (stage) {
      stage.addEventListener('touchstart', (event) => {
        startX = event.touches?.[0]?.clientX ?? null;
      }, { passive: true });
      stage.addEventListener('touchend', (event) => {
        if (startX === null) return;
        const endX = event.changedTouches?.[0]?.clientX ?? startX;
        const delta = endX - startX;
        startX = null;
        if (Math.abs(delta) < 40) return;
        go(local.current + (delta < 0 ? 1 : -1), { user: true });
      }, { passive: true });
      stage.addEventListener('mouseenter', () => { local.paused = true; clearTimeout(local.timer); });
      stage.addEventListener('mouseleave', () => { local.paused = false; schedule(); });
    }
    if (doc) doc.addEventListener('visibilitychange', () => {
      local.paused = doc.hidden;
      if (local.paused) clearTimeout(local.timer); else schedule();
    });
  }

  function build() {
    local.sections = buildHeroSections(manifest);
    local.byId = byId instanceof Map ? byId : new Map();
    const empty = !local.sections.length || !fallbackPhoto();
    doc?.body?.classList.toggle('is-empty', empty);
    if (controls) controls.hidden = empty || local.sections.length < 2;
    if (stage) stage.tabIndex = empty ? -1 : 0;
    if (!local.sections.length) {
      // 空站点：至少把标题写出来，首屏不留白 / Empty site: still show the title
      if (title) title.textContent = manifest?.site?.title || '个人相册';
      if (eyebrow) eyebrow.textContent = 'PHOTO ARCHIVE';
      if (subtitle) subtitle.textContent = manifest?.site?.subtitle || '';
      if (cta) cta.hidden = true;
      return;
    }
    render(0, { animate: false });
    schedule();
  }

  wireControls();
  build();

  return {
    update(nextManifest, nextById) {
      manifest = nextManifest;
      byId = nextById;
      build();
    },
    go,
    current: () => local.current,
    count: () => local.sections.length,
    sections: () => local.sections.slice(),
    destroy() { clearTimeout(local.timer); },
  };
}
