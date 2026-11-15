import {
  state, buildHash, parseHashString, filterPhotos, SEARCH_PAGE_SIZE,
  normalizeDensity, DENSITY_KEY,
} from './state.js';
import { loadManifest, buildIndex, resolveManifest, loadSearchIndex } from './data.js';
import { createCatalog, renderAlbums } from './gallery.js';
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
import { wanderOrder } from './wander.js';
import {
  ANCHOR_KEY, serializeAnchor, parseAnchor, nearestAnchor,
} from './anchor.js';
import { mountUploadLegend } from './upload-state.js';
import { initTheme, themeLabel } from './theme.js';
import { createYearPage, renderYearNav, buildYearSummary } from './year-page.js';

const ctx = {
  index: null,
  catalog: null,
  applying: false,
  lastHash: null,
  rev: '',
  scrollBeforeMode: 0,
  searchUI: null,
  wanderBase: null,
  yearPage: null,
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

/* ---------- 偏好（密度） ---------- */

/**
 * 偏好读写一律包在 try 里：隐私模式下 `localStorage` 可能直接抛异常，
 * 那也不该影响浏览——读不到就用默认值，存不了就算了。
 *
 * Preference reads/writes are wrapped: private mode can throw, and that must
 * never affect browsing.
 */
function readPref(key, fallback = '') {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不了就算了，本次会话内仍然生效 */
  }
}

function clearPref(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}

/* ---------- 回到上次位置（T-17） ---------- */

/** 参考线在视口上方 1/4 处：比顶边更贴近「我正在看哪一段」 */
const anchorLine = () => window.innerHeight * 0.25;

/** 从 DOM 收集「年 + 月 + 当前顶边」，只会用月份标题作锚点 */
function collectAnchors() {
  const out = [];
  for (const section of document.querySelectorAll('.year-group')) {
    const year = Number(section.dataset.year);
    for (const title of section.querySelectorAll('.month')) {
      out.push({
        year,
        month: Number(title.dataset.month),
        top: title.getBoundingClientRect().top,
      });
    }
  }
  return out;
}

/**
 * 记住位置：只在「纯时间流」里记——筛选结果、相册页、搜索态都不记，
 * 否则记忆会指向一个用户平时根本回不去的位置。
 */
function rememberAnchor() {
  if (state.mode || state.view !== 'timeline') return;
  if (state.album || state.q || state.tag || state.year || state.month) return;
  const entry = nearestAnchor(collectAnchors(), anchorLine());
  if (!entry?.month) return;
  const value = serializeAnchor(entry);
  if (value) {
    writePref(ANCHOR_KEY, value);
    paintAnchorReset();
  }
}

/** 恢复到上次的年月；返回 true 表示跳过了一次顶部对齐 */
function restoreAnchor() {
  const anchor = parseAnchor(readPref(ANCHOR_KEY));
  if (!anchor) return false;
  if (state.q || state.tag || state.year || state.month || state.album) return false;

  const node = document.querySelector(
    `.year-group[data-year="${anchor.year}"] .month[data-month="${anchor.month}"]`,
  );
  if (!node) return false;
  node.scrollIntoView({ block: 'start', behavior: 'auto' });
  // 吸顶导航会盖住月份标题，往下让出它的高度
  const nav = document.querySelector('.site-nav');
  if (nav) window.scrollBy(0, -(nav.getBoundingClientRect().height + 8));
  return true;
}

function paintAnchorReset() {
  const button = el('anchor-reset');
  if (!button) return;
  button.hidden = !readPref(ANCHOR_KEY);
}

/* ---------- 静态区块 ---------- */

function renderStats() {
  const { photos, albums } = ctx.index;
  el('stat-photos').textContent = String(photos.length);
  el('stat-albums').textContent = String(albums.length);
  el('stat-span').textContent = formatSpan(photos);
  el('footer-meta').textContent = `${photos.length} 张 · ${albums.length} 个相册 · ${formatSpan(photos)}`;
}

/**
 * 首屏（T-11）是静态 HTML，运行时只把 href 从构建期写死的 #catalog 升级成
 * 「打开首图那张」的深链接——复用既有的 #p= 键，不新增 hash 键。
 * The static hero only gets its href upgraded to the hero photo's deep link,
 * reusing the existing #p= key (no new hash keys).
 */
function paintHeroLink() {
  const link = el('hero-stage');
  if (link) link.setAttribute('href', ctx.index.hero ? `#p=${ctx.index.hero}` : '#catalog');
}

function renderSite() {
  paintHeroLink();
  document.body.classList.toggle('is-empty', ctx.index.photos.length === 0);
  renderStats();

  renderAlbums(el('album-grid'), ctx.index.albums, {
    photos: ctx.index.photos,
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
  // 输入框正在被编辑时不要回写：查询是 150ms 防抖的，这期间 state.q 还是旧值，
  // 任何一次 refresh 都会把用户刚打的字擦掉。
  // Don't write back while the field is being edited: the query is debounced,
  // so state.q still holds the old value and any refresh would erase keystrokes.
  const input = el('q');
  if (input && document.activeElement !== input) input.value = state.q;
  const hasFilter = Boolean(state.tag || state.year || state.month || state.q);
  el('clear').hidden = !hasFilter;
}

/* ---------- 渲染 ---------- */

/**
 * 视图切换 / View switch.
 *
 * 页面长相由三件事同时决定：视图（时间流 / 相册）、是否在搜索、是否停在相册根目录。
 * 搜索态把 hero 与页脚入口藏起来，让结果直接顶到导航下面——搜索时用户只想看结果，
 * 不想先滚过一屏大图。
 *
 * The page's shape is decided by three things at once: the view, whether a search
 * is active, and whether we are at the album root.
 */
function applyView() {
  const isAlbumRoot = state.view === 'album' && !state.album;
  // 年度页（T-24）：`view=year` 复用既有的 view 键，年份复用既有的 year 键，
  // 一个 hash 键都不新增。它是个独立视图，不叠在时间流上，所以 catalog 全藏。
  const isYear = state.view === 'year';
  const searching = state.mode === 'search';

  el('albums-section').hidden = !isAlbumRoot;
  el('catalog').hidden = isAlbumRoot || isYear;
  el('year-page').hidden = !isYear;
  el('back').hidden = !((state.view === 'album' && state.album) || isYear);
  el('catalog-title').textContent = searching
    ? '搜索结果'
    : (isYear ? `${state.year} 年` : (state.album || '全部照片'));

  el('top').hidden = searching || isAlbumRoot || isYear;
  el('footer-actions').hidden = searching;

  const albums = el('nav-albums');
  albums.setAttribute('aria-pressed', String(state.view === 'album'));
  albums.classList.toggle('is-active', state.view === 'album' && !searching);

  // 年份条的选中态跟着视图走，所以放在这里而不是只在进页面时刷一次
  if (ctx.index) {
    renderYearNav(el('year-nav'), ctx.index.years, {
      current: isYear ? state.year : '',
      onOpen: (year) => enterYear(year),
    });
  }
}

/**
 * 进年度页。年份缺省取清单里最新的一年——从导航点进来时没指定年份，
 * 落到「空白页」是最差的选择。
 */
function enterYear(year) {
  const fallback = ctx.index?.years?.[0];
  const target = String(year || state.year || fallback || '');
  if (!target) return;
  state.view = 'year';
  state.year = target;
  state.album = '';
  state.q = '';
  state.tag = '';
  state.month = '';
  state.mode = null;
  refresh();
  syncUrl(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 年度页靠清单 + 语义索引两张表，索引没到位时只是没有标签与主色 */
function renderYear() {
  if (!ctx.yearPage || !ctx.index) return;
  ctx.yearPage.render(buildYearSummary({
    photos: ctx.index.photos,
    items: state.search.index?.items || [],
    year: state.year,
  }));
}

function refresh() {
  const { items, meta } = computeFiltered();
  state.filtered = items;
  // 搜索态复用既有的 mode 键，不新增 hash 键；故事 / 照片墙覆盖层优先，不抢它们的 mode
  if (state.mode !== 'story' && state.mode !== 'wall') {
    state.mode = String(state.q || '').trim() ? 'search' : null;
  }
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

  if (state.view === 'year') {
    renderYear();
    el('sentinel').hidden = true;
    return;
  }
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
  } else if (!state.mode || state.mode === 'search') {
    // 搜索态也算「没有覆盖层」：它只是把 hero 藏起来，仍然要重新筛选 + 渲染
    if (isStoryOpen()) closeStory();
    if (isWallOpen()) exitWall();
    refresh();
  }

  ctx.applying = false;
  ctx.lastHash = location.hash;
  if (photoId) openById(photoId);
  else if (initial) window.scrollTo(0, 0);
  // 返回「是否已经定位到具体照片」：定位了就别再按记忆滚一次
  return Boolean(photoId);
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

/**
 * 进故事模式。`year` 给定时只播这一年——这是删掉「故事」tab 之后，
 * 故事唯一的入口，所以它必须能接受一个范围，而不是永远播全部。
 */
function enterStoryMode({ year = null, push = true } = {}) {
  const all = ctx.index.photos;
  const scope = year
    ? all.filter((photo) => photo.year === Number(year))
    : (state.filtered.length ? state.filtered : all);
  if (!scope.length) {
    if (year) toast(`${year} 年没有照片`);
    return;
  }
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
      paintHeroLink();
      state.filtered = computeFiltered().items;
      ctx.catalog.update(state.filtered, { reset: true });
    },
  });
  if (push) syncUrl(true);
}

/**
 * 随机漫游：把随机序列**当作灯箱的列表**，左右键就自然沿着这条序列走，
 * 不需要给灯箱加一条并行的「随机模式」——那种做法迟早和页码 / URL 打架。
 * 关灯箱时把 state.filtered 还回去（见 initLightbox 的 onClose）。
 */
function enterWander() {
  const photos = ctx.index.photos;
  if (!photos.length) return;
  const order = wanderOrder(photos, {
    nowYear: new Date().getFullYear(),
    seed: Date.now() >>> 0,
    limit: 20,
  });
  if (!order.length) return;
  ctx.wanderBase = state.filtered;
  state.filtered = order;
  openLightbox(order, 0);
  syncUrl(false);
}

/* ---------- 事件 ---------- */

function wire() {
  // 品牌 = 回时间流：删掉「时间轴」tab 之后，进了相册根目录没有别的路可回来
  el('brand').addEventListener('click', () => {
    state.view = 'timeline';
    state.album = '';
    state.q = '';
    refresh();
    syncUrl(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  el('nav-albums').addEventListener('click', () => {
    state.view = state.view === 'album' ? 'timeline' : 'album';
    if (state.view === 'timeline') state.album = '';
    refresh();
    syncUrl(true);
  });

  el('back').addEventListener('click', () => {
    // 年度页的「返回」是回时间流，不是回相册根目录——它本来就不在相册里
    if (state.view === 'year') {
      state.view = 'timeline';
      state.year = '';
    }
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

  el('density').addEventListener('change', (event) => {
    const value = normalizeDensity(event.target.value);
    writePref(DENSITY_KEY, value);
    ctx.catalog.setDensity(value);
  });

  // 每年分组末尾的「用故事播放这一年」：事件委托，免得每建一个年份就挂一个监听
  el('content').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-story-year]');
    if (!button) return;
    enterStoryMode({ year: Number(button.dataset.storyYear) });
  });
  el('open-wander').addEventListener('click', () => enterWander());
  el('open-wall').addEventListener('click', () => launchWall());
  el('theme-toggle').addEventListener('click', () => theme.next());

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

  // 滚动位置记忆：rAF 节流，滚动中不做任何布局读写以外的事
  let anchorFrame = 0;
  window.addEventListener('scroll', () => {
    if (anchorFrame) return;
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = 0;
      rememberAnchor();
    });
  }, { passive: true });

  el('anchor-reset').addEventListener('click', () => {
    clearPref(ANCHOR_KEY);
    paintAnchorReset();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

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

  const density = normalizeDensity(readPref(DENSITY_KEY, 'standard'));
  ctx.catalog = createCatalog({
    container: el('content'),
    onOpen: (index) => openAt(index),
    density,
  });
  el('density').value = density;

  initLightbox({
    onNavigate: () => syncUrl(false),
    // chips（T-19）：拿识别标签里出现过的中文词。索引还没到位时返回空数组，
    // 横条照常显示，只是暂时没有 chips。
    labelsFor: (photo) => {
      const items = state.search.index?.items;
      if (!Array.isArray(items)) return [];
      const hit = items.find((item) => item.id === photo?.id);
      return Array.isArray(hit?.labels) ? hit.labels : [];
    },
    onChip: (term) => {
      const word = String(term || '').trim();
      if (!word) return;
      closeLightbox();
      state.q = word;
      state.mode = 'search';
      refresh();
      syncUrl(true);
    },
    onClose: () => {
      state.lightbox.index = -1;
      // 漫游期间 state.filtered 被换成了随机序列，关掉要还回去，
      // 否则之后点瓦片的下标会和 state.filtered 对不上
      if (ctx.wanderBase) {
        state.filtered = ctx.wanderBase;
        ctx.wanderBase = null;
      }
      syncUrl(false);
    },
  });
  initStory();
  initWall();
  initMotion();

  fillFilters();
  renderSite();

  // 年度页（T-24）：三个出口都回时间流，只是带的筛选不同——
  // 点月份带 year+month，点标签变成搜索，点「看这一年的照片」只带 year。
  ctx.yearPage = createYearPage({
    host: el('year-page'),
    onPickMonth: (month) => {
      state.view = 'timeline';
      state.month = String(month);
      refresh();
      syncUrl(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onPickTag: (zh) => {
      const word = String(zh || '').trim();
      if (!word) return;
      state.view = 'timeline';
      state.month = '';
      state.q = word;
      state.mode = 'search';
      refresh();
      syncUrl(true);
    },
    onReset: () => {
      state.view = 'timeline';
      state.month = '';
      refresh();
      syncUrl(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  });
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
  // 关掉浏览器的自动滚动恢复：我们自己按年月恢复，避免「先跳顶部再跳回来」的闪动
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const restored = await applyFromHash({ initial: true });
  if (!restored) restoreAnchor();
  paintAnchorReset();
}

/* ---------- 主题（T-14） ---------- */

/**
 * 三档主题在模块加载时就装好，而不是等清单到位——清单拉取失败时页面只剩一个
 * 报错 toast，那时候用户照样该能换主题。首屏的 `data-theme` 已经由 index.html
 * head 里的同步脚本写过，这里接的是之后的切换、持久化与 meta 同步。
 *
 * The theme is installed at module load rather than after the manifest, so it
 * still works when the manifest fetch fails. The first-paint `data-theme` came
 * from the inline head script; this takes over switching, persistence and meta.
 */
const theme = initTheme({ onChange: () => paintThemeButton() });

function paintThemeButton() {
  const button = el('theme-toggle');
  if (!button) return;
  // 按钮上写「现在是什么档」，而不是「点一下会变成什么」——后者在跟随档下没法描述
  const label = themeLabel(theme.choice);
  button.textContent = label;
  button.setAttribute('aria-label', `${label}，点击切换`);
  button.dataset.theme = theme.resolved;
}

paintThemeButton();

boot();
