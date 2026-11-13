import { state, buildHash, parseHashString, filterPhotos } from './state.js';
import { loadManifest, buildIndex, resolveManifest } from './data.js';
import { createCatalog, renderFeatured, renderAlbums } from './gallery.js';
import { initLightbox, openLightbox, closeLightbox, isLightboxOpen } from './lightbox.js';
import { initStory, openStory, closeStory, isStoryOpen } from './story.js';
import { initWall, enterWall, exitWall, isWallOpen } from './wall.js';
import { initMotion, photoTransition } from './motion.js';
import { installBackBridge } from './native.js';
import { initUpload } from './upload.js';
import {
  el, toast, formatSpan, photoAlt, srcsetFor, sizesFor, reducedMotion,
} from './ui.js';

const DEFAULT_SUBTITLE = '按时间、相册与标签，重新翻阅这些瞬间。';

const ctx = {
  index: null,
  catalog: null,
  applying: false,
  lastHash: null,
  rev: '',
  scrollBeforeMode: 0,
  heroIndex: 0,
  heroTimer: null,
};

function manifestRev(url) {
  const match = /manifest\.([0-9a-f]+)\.json/.exec(url || '');
  return match ? match[1] : '';
}

/* ---------- 静态区块 ---------- */

function renderHero() {
  const { photos, hero } = ctx.index;
  const sections = ctx.index.heroSections.length
    ? ctx.index.heroSections
    : [{ photo: hero, eyebrow: `PHOTO ARCHIVE · ${photos.length} 个瞬间` }];
  const section = sections[ctx.heroIndex % sections.length];
  const photo = photos.find((item) => item.id === section.photo) || photos[0];
  const media = el('hero-media');
  const title = el('site-title');
  const subtitle = el('site-subtitle');
  const eyebrow = el('hero-eyebrow');
  const cta = el('hero-cta');

  title.textContent = section.title || state.data?.site?.title || 'PHOTO ARCHIVE';
  const sub = section.subtitle || state.data?.site?.subtitle || '';
  subtitle.textContent = sub || DEFAULT_SUBTITLE;
  eyebrow.textContent = section.eyebrow || 'PHOTO ARCHIVE';
  cta.hidden = !section.cta;
  cta.textContent = section.cta || '';
  cta.href = section.target || '#catalog';

  if (!photo) {
    media.removeAttribute('src');
    media.alt = '';
    document.body.classList.add('is-empty');
    return;
  }
  media.classList.toggle('is-switching', !reducedMotion.matches);
  media.srcset = srcsetFor(photo, 'feature');
  media.sizes = sizesFor('feature');
  const revealHero = () => media.classList.remove('is-switching');
  media.addEventListener('load', revealHero, { once: true });
  media.src = photo.view || photo.grid || photo.poster;
  media.alt = photoAlt(photo);
  if (media.complete && media.naturalWidth > 0) revealHero();
  preloadHeroSections(sections, ctx.heroIndex);

  // 舞台高度跟着照片比例走（D-01：满幅宽度 + 按比例算高度，不裁切）
  const ratio = Number(photo.ratio);
  document.querySelector('.hero')?.style.setProperty('--hero-ratio', String(Number.isFinite(ratio) && ratio > 0 ? ratio : 1.5));
}

function preloadHeroSections(sections, index) {
  for (const offset of [0, 1]) {
    const section = sections[(index + offset) % sections.length];
    const photo = ctx.index.photos.find((item) => item.id === section.photo);
    if (!photo) continue;
    const image = new Image();
    image.srcset = srcsetFor(photo, 'feature');
    image.sizes = sizesFor('feature');
    image.src = photo.view || photo.grid || photo.poster;
  }
}

function shouldRotateHero() {
  return !reducedMotion.matches
    && !navigator.connection?.saveData
    && !(Number(navigator.hardwareConcurrency) > 0 && navigator.hardwareConcurrency <= 2);
}

function startHeroRotation() {
  clearTimeout(ctx.heroTimer);
  const sections = ctx.index?.heroSections || [];
  if (sections.length < 2 || !shouldRotateHero()) return;
  const nextDuration = () => Math.max(3000, Number(sections[ctx.heroIndex]?.duration) || 6500);
  const schedule = () => {
    ctx.heroTimer = setTimeout(() => {
      ctx.heroIndex = (ctx.heroIndex + 1) % sections.length;
      renderHero();
      schedule();
    }, nextDuration());
  };
  schedule();
}

function renderStats() {
  const { photos, albums } = ctx.index;
  el('stat-photos').textContent = String(photos.length);
  el('stat-albums').textContent = String(albums.length);
  el('stat-span').textContent = formatSpan(photos);
  el('footer-meta').textContent = `${photos.length} 张 · ${albums.length} 个相册 · ${formatSpan(photos)}`;
}

function featuredPhotos() {
  const { photos } = ctx.index;
  const picked = photos.filter((photo) => photo.featured);
  // 标记不足 3 条时用最新照片补齐，避免「精选」只剩一张
  if (picked.length >= 3) return picked.slice(0, 4);
  const used = new Set(picked.map((photo) => photo.id));
  const filler = photos.filter((photo) => !used.has(photo.id));
  return [...picked, ...filler].slice(0, Math.min(3, photos.length));
}

function renderSite() {
  ctx.heroIndex = 0;
  renderHero();
  startHeroRotation();
  renderStats();

  const featured = featuredPhotos();
  const host = el('featured-stream');
  const hasFeatured = renderFeatured(host, featured, { onOpen: (photo) => openById(photo.id) });
  el('featured').hidden = !hasFeatured;

  renderAlbums(el('album-grid'), ctx.index.albums, {
    byId: ctx.index.byId,
    onOpenAlbum: (name) => {
      state.view = 'album';
      state.album = name;
      applyView();
      syncUrl(true);
    },
  });
}

/* ---------- 筛选器 ---------- */

function fillFilters() {
  const fill = (select, values, formatter) => {
    const current = select.value;
    select.replaceChildren(new Option('全部', ''));
    for (const value of values) select.appendChild(new Option(formatter(value), String(value)));
    select.value = current;
  };
  fill(el('tag'), ctx.index.tags, (value) => value);
  fill(el('year'), ctx.index.years, (value) => `${value} 年`);
  fill(el('month'), ctx.index.months, (value) => `${value} 月`);
}

function syncControlValues() {
  el('tag').value = state.tag;
  el('year').value = state.year;
  el('month').value = state.month;
  el('q').value = state.q;
  const hasFilter = Boolean(state.tag || state.year || state.month || state.q);
  el('clear').hidden = !hasFilter;
}

function renderSearchTools() {
  const semanticSuggestions = ['湖水', '山峰', '蓝天', '汽车', '摩托车', '红色衬衫'];
  const suggestions = [...new Set([
    ...semanticSuggestions,
    ...ctx.index.tags,
    ...ctx.index.photos.map((photo) => photo.title).filter(Boolean),
  ])].slice(0, 8);
  const renderChips = (host, values, onSelect, formatter = (value) => value) => {
    host.replaceChildren();
    for (const value of values) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-chip';
      button.textContent = formatter(value);
      button.addEventListener('click', () => onSelect(value));
      host.appendChild(button);
    }
  };
  renderChips(el('search-suggestions'), suggestions, (value) => {
    state.q = value;
    refresh();
    syncUrl(true);
    el('q').focus();
  });
  renderChips(el('search-years'), ctx.index.years.slice(0, 5), (value) => {
    state.q = '';
    state.year = String(value);
    refresh();
    syncUrl(true);
  }, (value) => `${value} 年`);
}

function renderSearchStatus() {
  const node = el('search-status');
  const query = state.q.trim();
  const hasFilter = Boolean(query || state.tag || state.year || state.month);
  if (!hasFilter) {
    node.textContent = '支持照片标题、标签、相册和年份；搜索服务不可用时仍可使用基础筛选。';
    node.classList.remove('is-empty', 'is-error');
    return;
  }
  const count = state.filtered.length;
  if (!count) {
    node.textContent = query
      ? `没有找到“${query}”。可以尝试标签、相册名或年份。`
      : '没有符合条件的照片，请调整筛选条件。';
    node.classList.add('is-empty');
    node.classList.remove('is-error');
    return;
  }
  const source = query ? '本地基础筛选' : '基础筛选';
  node.textContent = `找到 ${count} 张照片 · ${source}`;
  node.classList.remove('is-empty', 'is-error');
}

/* ---------- 渲染 ---------- */

function applyView() {
  const isAlbumRoot = state.view === 'album' && !state.album;
  el('albums-section').hidden = !isAlbumRoot;
  el('catalog').hidden = isAlbumRoot;
  el('back').hidden = !(state.view === 'album' && state.album);
  el('catalog-title').textContent = state.album || '全部照片';

  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }

  if (isAlbumRoot) {
    el('featured').hidden = true;
    return;
  }
  el('featured').hidden = !featuredPhotos().length;
}

function refresh() {
  state.filtered = filterPhotos(ctx.index.photos, state);
  const hasFilter = Boolean(state.tag || state.year || state.month || state.q);
  el('photo-count').textContent = hasFilter
    ? `${state.filtered.length} / ${ctx.index.photos.length} 张`
    : `${state.filtered.length} 张`;

  applyView();
  syncControlValues();
  renderSearchStatus();

  if (state.view === 'album' && !state.album) return;
  ctx.catalog.update(state.filtered, { reset: true });
  el('sentinel').hidden = !ctx.catalog.hasMore;
}

/* ---------- 灯箱 ---------- */

function openById(id) {
  const index = state.filtered.findIndex((photo) => photo.id === id);
  if (index < 0) {
    toast('这张照片已不在当前筛选结果中');
    return;
  }
  openAt(index, { fromHash: true });
}

function openAt(index, { fromHash = false } = {}) {
  const photo = state.filtered[index];
  if (!photo) return;
  const tileImage = document.querySelector(`.tile[data-index="${index}"] img`);
  const run = () => {
    openLightbox(state.filtered, index);
    if (!fromHash) syncUrl(true);
  };
  if (tileImage) photoTransition(tileImage, photo.id, run);
  else run();
}

/* ---------- URL ---------- */

function syncUrl(push = false) {
  if (ctx.applying) return;
  const hash = buildHash();
  if (hash === location.hash) return;
  const url = location.pathname + location.search + hash;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  ctx.lastHash = hash;
}

async function applyFromHash({ initial = false } = {}) {
  ctx.applying = true;
  const photoId = parseHashString(location.hash, state);

  if (state.mode === 'story' && !isStoryOpen()) {
    refresh();
    openStoryForScope();
  } else if (state.mode === 'wall' && !isWallOpen()) {
    refresh();
    launchWall();
  } else if (!state.mode) {
    if (isStoryOpen()) closeStory();
    if (isWallOpen()) exitWall();
    refresh();
  }

  ctx.applying = false;
  ctx.lastHash = location.hash;
  if (photoId) openById(photoId);
  else if (initial) window.scrollTo(0, 0);
}

/* ---------- 模式 ---------- */

function leaveMode() {
  if (!state.mode) return;
  state.mode = null;
  const hash = buildHash();
  history.replaceState(null, '', location.pathname + location.search + hash);
  ctx.lastHash = hash;
  window.scrollTo(0, ctx.scrollBeforeMode);
}

function startStory(scope) {
  state.mode = 'story';
  openStory(scope, { pace: state.pace, onClose: leaveMode });
}

function enterStoryMode(push = true) {
  const scope = state.filtered.length ? state.filtered : ctx.index.photos;
  if (!scope.length) return;
  ctx.scrollBeforeMode = window.scrollY;
  startStory(scope);
  if (push) syncUrl(true);
}

function openStoryForScope() {
  const scope = state.filtered.length ? state.filtered : ctx.index.photos;
  ctx.scrollBeforeMode = window.scrollY;
  startStory(scope);
}

function launchWall(push = true) {
  const photos = ctx.index.photos;
  if (!photos.length) return;
  ctx.scrollBeforeMode = window.scrollY;
  state.mode = 'wall';
  const wallOptions = state.data?.wall || {};
  enterWall(photos, {
    interval: wallOptions.interval || 10,
    clock: wallOptions.clock !== false,
    night: wallOptions.night,
    rev: ctx.rev,
    onClose: leaveMode,
    onManifest: (manifest) => {
      state.data = manifest;
      ctx.index = buildIndex(manifest);
      fillFilters();
      renderStats();
      ctx.catalog.update(filterPhotos(ctx.index.photos, state), { reset: true });
    },
  });
  if (push) syncUrl(true);
}

/* ---------- 事件 ---------- */

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.view = tab.dataset.view;
      if (state.view === 'timeline') state.album = '';
      refresh();
      syncUrl(true);
    });
  }

  el('back').addEventListener('click', () => {
    state.album = '';
    refresh();
    syncUrl(true);
  });

  el('q').addEventListener('input', (event) => {
    state.q = event.target.value.trim();
    refresh();
    syncUrl(true);
  });

  for (const id of ['tag', 'year', 'month']) {
    el(id).addEventListener('change', (event) => {
      state[id] = event.target.value;
      refresh();
      syncUrl(true);
    });
  }

  el('clear').addEventListener('click', () => {
    state.q = '';
    state.tag = '';
    state.year = '';
    state.month = '';
    refresh();
    syncUrl(true);
  });

  el('open-story').addEventListener('click', () => enterStoryMode());
  el('story-cta-button').addEventListener('click', () => enterStoryMode());
  el('open-wall').addEventListener('click', () => launchWall());
  el('wall-cta-button').addEventListener('click', () => launchWall());

  const more = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (!ctx.catalog?.hasMore) {
      el('sentinel').hidden = true;
      return;
    }
    ctx.catalog.more();
    if (!ctx.catalog.hasMore) el('sentinel').hidden = true;
  }, { rootMargin: '600px' });
  more.observe(el('sentinel'));

  window.addEventListener('popstate', () => {
    if (location.hash === ctx.lastHash) return;
    applyFromHash();
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === ctx.lastHash) return;
    applyFromHash();
  });
}

/* ---------- 原生返回键 ---------- */

/**
 * 页面「有没有内层状态」：有的话返回键应该由页面消化，
 * 而不是直接退出 App。顺序与用户的心理模型一致——
 * 先关最上面那一层，再退视图，最后才是退出。
 *
 * Whether the page holds inner state. If it does, the back key belongs to the
 * page: close the topmost layer first, then leave the view, only then quit.
 */
function hasInnerState() {
  return isLightboxOpen()
    || isStoryOpen()
    || isWallOpen()
    || state.view !== 'timeline'
    || Boolean(state.album || state.q || state.tag || state.year || state.month);
}

/** 执行一次返回；返回 true 表示页面自己消化了，false 交给原生退出 */
function goBack() {
  if (isLightboxOpen()) {
    closeLightbox();
    syncUrl(false);
    return true;
  }
  if (isStoryOpen()) {
    closeStory();
    return true;
  }
  if (isWallOpen()) {
    exitWall();
    return true;
  }
  if (!hasInnerState()) return false;

  state.view = 'timeline';
  state.album = '';
  state.q = '';
  state.tag = '';
  state.year = '';
  state.month = '';
  refresh();
  syncUrl(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

/* ---------- 启动 ---------- */

async function boot() {
  el('search-status').textContent = '正在载入照片清单…';
  // 先取 version.json 再取清单：前端产物不再包含任何清单地址
  // Fetch version.json first; the shell no longer embeds a manifest URL
  let source;
  try {
    source = await resolveManifest();
  } catch (err) {
    el('search-status').textContent = '照片清单载入失败，基础筛选暂不可用，请刷新重试。';
    el('search-status').classList.add('is-error');
    toast('照片清单载入失败，请刷新重试');
    console.error(err);
    return;
  }

  const url = source.url;
  ctx.rev = source.rev || manifestRev(url);

  let manifest;
  try {
    manifest = await loadManifest(url);
  } catch (err) {
    el('search-status').textContent = '照片清单载入失败，基础筛选暂不可用，请刷新重试。';
    el('search-status').classList.add('is-error');
    toast('照片清单载入失败，请刷新重试');
    console.error(err);
    return;
  }

  state.data = manifest;
  ctx.index = buildIndex(manifest);
  state.filtered = ctx.index.photos;

  ctx.catalog = createCatalog({
    container: el('content'),
    onOpen: (index) => openAt(index),
  });

  initLightbox({
    onNavigate: () => syncUrl(false),
    onClose: () => {
      state.lightbox.index = -1;
      syncUrl(false);
    },
  });
  initStory();
  initWall();
  initMotion();

  fillFilters();
  renderSearchTools();
  renderSite();
  wire();
  // 安卓壳通过它决定返回键是关内层还是退出 Activity
  installBackBridge({ canGoBack: hasInnerState, goBack });
  // 上传入口只在「有原生桥 + 配了接口地址」时才挂载，浏览器里是空操作
  initUpload();
  await applyFromHash({ initial: true });
}

boot();
