import { state, buildHash, parseHashString, filterPhotos, SEARCH_PAGE_SIZE } from './state.js';
import { loadManifest, buildIndex, resolveManifest, loadSearchIndex } from './data.js';
import { createCatalog, renderFeatured, renderAlbums } from './gallery.js';
import { initLightbox, openLightbox, closeLightbox, isLightboxOpen } from './lightbox.js';
import { initStory, openStory, closeStory, isStoryOpen } from './story.js';
import { initWall, enterWall, exitWall, isWallOpen } from './wall.js';
import { initMotion, photoTransition } from './motion.js';
import { installBackBridge } from './native.js';
import { initUpload } from './upload.js';
import { el, toast, formatSpan } from './ui.js';
import {
  parseQuery, runSearch, indexUrl, isIndexUsable, sanitizeIndex, INDEX_VERSION,
} from './search.js';
import { initSearchUI } from './search-ui.js';
import { initHero } from './hero.js';
import { mountUploadLegend } from './upload-state.js';

const ctx = {
  index: null,
  catalog: null,
  applying: false,
  lastHash: null,
  rev: '',
  scrollBeforeMode: 0,
  hero: null,
  searchUI: null,
};

function manifestRev(url) {
  const match = /manifest\.([0-9a-f]+)\.json/.exec(url || '');
  return match ? match[1] : '';
}

/* ---------- 语义搜索 / Semantic search ---------- */

/**
 * 统一入口：显式筛选（相册/标签/年/月）始终生效；q 交给 search.js。
 * 索引可用走本地索引检索，不可用则降级为 manifest 本地筛选。
 * 两条路径返回的都是 ctx.index.photos 里的同一批对象，供现有渲染器复用，
 * 不会另建第二套模型。
 *
 * Unified entry: explicit filters always apply; `q` goes through search.js
 * (index path or manifest fallback). Both return the same photo objects so the
 * existing renderer is reused — no second gallery model.
 */
function computeFiltered() {
  const all = ctx.index.photos;
  const scoped = filterPhotos(all, { ...state, q: '' });
  const q = String(state.q || '').trim();
  if (!q) {
    return {
      items: scoped,
      meta: {
        status: 'idle', queryStatus: 'idle', parse: null, total: scoped.length, degraded: false, error: '',
      },
    };
  }
  const parse = parseQuery(q);
  const result = runSearch({
    index: state.search.index,
    parse,
    photos: scoped,
    query: q,
    indexOptions: { version: INDEX_VERSION },
    page: 1,
    pageSize: SEARCH_PAGE_SIZE,
  });
  return {
    // catalog 自己做分批渲染（等效客户端分页），这里交付完整排序结果
    // The catalog does progressive rendering (client-side paging) itself.
    items: result.matched,
    meta: {
      // status 是**索引加载**生命周期（loading/ready/degraded）；
      // queryStatus 是**查询**四态（idle/ok/no-match/unknown-term/degraded）。
      // 两者目标不同：前者驱动「正在检索…」，后者驱动空结果文案。
      // status is the index-load lifecycle; queryStatus is the query four-state.
      status: state.search.status,
      queryStatus: result.queryStatus,
      parse,
      total: result.total,
      degraded: result.degraded,
      error: state.search.error,
    },
  };
}

/**
 * 载入静态索引。缺失 / 过期 / 加载失败都收敛成「基础筛选可用」，
 * 绝不因为搜索不可用而阻塞照片浏览。
 *
 * Load the static index. Missing / stale / failed loads all converge to
 * "baseline filtering available"; search never blocks photo browsing.
 */
async function loadIndex() {
  state.search.status = 'loading';
  state.search.error = '';
  ctx.searchUI?.render({ q: state.q, status: 'loading', years: ctx.index?.years || [] });

  let raw = null;
  try {
    raw = await loadSearchIndex(indexUrl(ctx.rev));
  } catch {
    try { raw = await loadSearchIndex('data/search-index.json'); } catch { raw = null; }
  }
  const clean = sanitizeIndex(raw);
  state.search.index = null;
  state.search.rev = ctx.rev;
  if (clean && isIndexUsable(clean, { version: INDEX_VERSION })) {
    state.search.index = clean;
    state.search.status = 'ready';
  } else {
    state.search.status = 'degraded';
    state.search.error = '索引不可用';
  }
  refresh();
}

/** 搜索框输入 → 写入 state.q + URL，并即时重算 / Query input -> state.q + URL + refresh */
function onQuery(q) {
  state.q = String(q || '').trim();
  refresh();
  syncUrl(true);
}

/* ---------- 静态区块 ---------- */

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
  // 数据驱动的多章节 hero：无配置自动生成，首屏同步可见。
  // Data-driven multi-section hero: auto-generated when unconfigured, first
  // paint is synchronous so the hero is never blank.
  ctx.hero = initHero(state.data, ctx.index.byId);
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
  const { items, meta } = computeFiltered();
  state.filtered = items;
  const hasFilter = Boolean(state.tag || state.year || state.month || state.q);
  el('photo-count').textContent = hasFilter
    ? `${state.filtered.length} / ${ctx.index.photos.length} 张`
    : `${state.filtered.length} 张`;

  applyView();
  syncControlValues();

  // 搜索状态（建议 / 时间 chip / 解释 / 空结果 / 加载 / 错误）统一交给 search-ui
  // Search status is delegated to search-ui as a single render call.
  ctx.searchUI?.render({
    q: state.q,
    status: meta.status,
    queryStatus: meta.queryStatus,
    parse: meta.parse,
    total: meta.total,
    degraded: meta.degraded,
    years: ctx.index.years,
    error: meta.error,
  });

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
      ctx.hero?.update(manifest, ctx.index.byId);
      state.filtered = computeFiltered().items;
      ctx.catalog.update(state.filtered, { reset: true });
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

  // #q 的输入事件由 search-ui.js 统一处理（单一所有者，避免重复监听）
  // The #q input is owned by search-ui.js (single owner, no double listener).
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
  // V5：搜索界面、五态图例；两者都只在已有静态骨架上装配，不新建第二套模型。
  // V5: search UI and the five-state legend, mounted on the existing skeleton.
  ctx.searchUI = initSearchUI({ onQuery, onRetry: loadIndex });
  mountUploadLegend(el('upload-legend'));
  wire();
  // 安卓壳通过它决定返回键是关内层还是退出 Activity
  installBackBridge({ canGoBack: hasInnerState, goBack });
  // 上传入口只在「有原生桥 + 配了接口地址」时才挂载，浏览器里是空操作
  initUpload();
  // 索引不可用时静默降级，不阻塞任何浏览路径（见 loadIndex）
  // Index outage degrades silently and never blocks browsing (see loadIndex).
  await loadIndex();
  await applyFromHash({ initial: true });
}

boot();
