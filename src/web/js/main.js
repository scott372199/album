import { state, buildHash, parseHashString, filterPhotos } from './state.js';
import { loadManifest, buildIndex, resolveManifest } from './data.js';
import { createCatalog, renderFeatured, renderAlbums } from './gallery.js';
import { initLightbox, openLightbox, closeLightbox, isLightboxOpen } from './lightbox.js';
import { initStory, openStory, closeStory, isStoryOpen } from './story.js';
import { initWall, enterWall, exitWall, isWallOpen } from './wall.js';
import { initMotion, photoTransition } from './motion.js';
import { el, toast, formatSpan, photoAlt } from './ui.js';

const DEFAULT_SUBTITLE = '按时间、相册与标签，重新翻阅这些瞬间。';

const ctx = {
  index: null,
  catalog: null,
  applying: false,
  lastHash: null,
  rev: '',
  scrollBeforeMode: 0,
};

function manifestRev(url) {
  const match = /manifest\.([0-9a-f]+)\.json/.exec(url || '');
  return match ? match[1] : '';
}

/* ---------- 静态区块 ---------- */

function renderHero() {
  const { photos, hero } = ctx.index;
  const photo = photos.find((item) => item.id === hero) || photos[0];
  const media = el('hero-media');
  const title = el('site-title');
  const subtitle = el('site-subtitle');
  const eyebrow = el('hero-eyebrow');

  title.textContent = state.data?.site?.title || '个人相册';
  const sub = state.data?.site?.subtitle || '';
  subtitle.textContent = sub || DEFAULT_SUBTITLE;

  if (!photo) {
    media.removeAttribute('src');
    media.alt = '';
    document.body.classList.add('is-empty');
    return;
  }
  media.src = photo.view || photo.grid || photo.poster;
  media.alt = photoAlt(photo);
  eyebrow.textContent = `PHOTO ARCHIVE · ${photos.length} 个瞬间`;

  // 舞台高度跟着照片比例走（D-01：满幅宽度 + 按比例算高度，不裁切）
  const ratio = Number(photo.ratio);
  document.querySelector('.hero')?.style.setProperty('--hero-ratio', String(Number.isFinite(ratio) && ratio > 0 ? ratio : 1.5));
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
  renderHero();
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

/* ---------- 启动 ---------- */

async function boot() {
  // 先取 version.json 再取清单：前端产物不再包含任何清单地址
  // Fetch version.json first; the shell no longer embeds a manifest URL
  let source;
  try {
    source = await resolveManifest();
  } catch (err) {
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
  renderSite();
  wire();
  await applyFromHash({ initial: true });
}

boot();
