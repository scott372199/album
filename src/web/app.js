const MANIFEST_URL = (typeof window !== 'undefined' && window.ALBUM_MANIFEST) || 'data/manifest.json';
const PLAY_INTERVAL = 4000;
const DEFAULT_SUBTITLE = '按时间、相册与标签，重新翻阅这些瞬间。';
const REDUCED_MOTION = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: true };

const state = {
  data: null,
  view: 'timeline',
  album: '',
  q: '',
  tag: '',
  year: '',
  month: '',
  filtered: [],
  lightbox: {
    index: -1, timer: null, lastFocus: null, touchX: null,
    zoom: 1, panX: 0, panY: 0, pinch: null,
  },
};

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function photoAlt(photo) {
  return photo.title || `${photo.album} · ${photo.year}年${photo.month}月`;
}

function matches(photo) {
  if (state.album && photo.album !== state.album) return false;
  if (state.tag && !photo.tags.includes(state.tag)) return false;
  if (state.year && photo.year !== Number(state.year)) return false;
  if (state.month && photo.month !== Number(state.month)) return false;
  if (state.q) {
    const haystack = [photo.title, photo.caption, photo.album, ...photo.tags].join(' ').toLowerCase();
    if (!haystack.includes(state.q.toLowerCase())) return false;
  }
  return true;
}

function groupByYearMonth(list) {
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

/* ---------- URL hash state (FR-09) ---------- */
let applyingHash = false;
let lastAppliedHash = null;

export function buildHash(snapshot = state) {
  const p = new URLSearchParams();
  if (snapshot.view !== 'timeline') p.set('view', snapshot.view);
  if (snapshot.album) p.set('album', snapshot.album);
  if (snapshot.q) p.set('q', snapshot.q);
  if (snapshot.tag) p.set('tag', snapshot.tag);
  if (snapshot.year) p.set('year', snapshot.year);
  if (snapshot.month) p.set('month', snapshot.month);
  const current = snapshot.filtered[snapshot.lightbox.index];
  if (snapshot.lightbox.index >= 0 && current) p.set('p', current.id);
  const value = p.toString();
  return value ? `#${value}` : '';
}

function syncUrl(push = false) {
  if (applyingHash) return;
  const hash = buildHash();
  if (hash === location.hash) return;
  const url = location.pathname + location.search + hash;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  lastAppliedHash = hash;
}

export function parseHashString(raw, snapshot) {
  const params = new URLSearchParams(String(raw).replace(/^#/, ''));
  snapshot.view = 'timeline';
  snapshot.album = '';
  snapshot.q = '';
  snapshot.tag = '';
  snapshot.year = '';
  snapshot.month = '';
  snapshot.lightbox.index = -1;

  const view = params.get('view');
  if (view === 'album' || view === 'timeline') snapshot.view = view;
  snapshot.album = params.get('album') || '';
  snapshot.q = params.get('q') || '';
  snapshot.tag = params.get('tag') || '';
  const year = Number(params.get('year'));
  if (Number.isInteger(year) && year > 1900 && year < 2200) snapshot.year = String(year);
  const month = Number(params.get('month'));
  if (Number.isInteger(month) && month >= 1 && month <= 12) snapshot.month = String(month);
  return params.get('p') || '';
}

function parseHash() {
  return parseHashString(location.hash, state);
}

function syncInputs() {
  el('q').value = state.q;
  el('tag').value = state.tag;
  el('year').value = state.year;
  el('month').value = state.month;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
}

function applyHash() {
  if (applyingHash) return;
  applyingHash = true;
  lastAppliedHash = location.hash;
  try {
    const photoId = parseHash();
    syncInputs();
    if (!state.data) return;
    render();
    if (photoId) {
      const index = state.filtered.findIndex((photo) => photo.id === photoId);
      if (index >= 0) {
        openLightbox(index, { sync: false });
      } else {
        closeLightbox({ sync: false, restore: false });
        showToast('这张照片不在当前结果中，已回到列表');
      }
    } else {
      closeLightbox({ sync: false, restore: false });
    }
  } finally {
    applyingHash = false;
  }
}

/* ---------- Rendering ---------- */
function photoCard(entry) {
  const { photo, index } = entry;
  const ratio = Number(photo.ratio) > 0 ? Number(photo.ratio) : 1;
  return `<figure class="photo reveal" data-ratio="${ratio}" style="aspect-ratio:${ratio}">
    <img src="${escapeHtml(photo.thumb)}" alt="${escapeHtml(photoAlt(photo))}"
         loading="lazy" decoding="async" data-idx="${index}" tabindex="0">
  </figure>`;
}

function timelineHtml(list) {
  return groupByYearMonth(list).map((group) => `
    <section class="year-group">
      <h2 class="year">${group.year}</h2>
      ${group.months.map((bucket) => `
        <section class="month-group">
          <h3 class="month">${bucket.month} 月 <span>${bucket.items.length} 张</span></h3>
          <div class="justified">${bucket.items.map(photoCard).join('')}</div>
        </section>`).join('')}
    </section>`).join('');
}

function albumCardsHtml(list) {
  const groups = new Map();
  for (const photo of list) {
    if (!groups.has(photo.album)) groups.set(photo.album, []);
    groups.get(photo.album).push(photo);
  }
  if (!groups.size) return '';
  return `<div class="album-grid">${[...groups.entries()].map(([name, items]) => `
    <button type="button" class="album-card reveal" data-album="${escapeHtml(name)}">
      <div class="cover"><img src="${escapeHtml(items[0].thumb)}" alt="${escapeHtml(name)}" loading="lazy"></div>
      <h3>${escapeHtml(name)}</h3>
      <p>${items.length} 张</p>
    </button>`).join('')}</div>`;
}

let resizeObserver = null;
let revealObserver = null;
let layoutTimer = null;
const widthMemo = new WeakMap();

function layoutMetrics() {
  const width = window.innerWidth;
  if (width >= 1100) return { target: 300, gap: 18 };
  if (width >= 720) return { target: 220, gap: 14 };
  return { target: 150, gap: 10 };
}

/** 纯函数：按宽高比把顺序固定的条目分行，返回每行条目与目标高度。 */
export function computeRows(items, width, target, gap) {
  const rows = [];
  let pending = [];
  let sumRatio = 0;
  for (const item of items) {
    const ratio = Number(item.ratio) > 0 ? Number(item.ratio) : 1;
    pending.push({ ...item, ratio });
    sumRatio += ratio;
    const usable = width - (pending.length - 1) * gap;
    const rowHeight = usable / sumRatio;
    if (rowHeight <= target) {
      rows.push({ items: pending, height: rowHeight });
      pending = [];
      sumRatio = 0;
    }
  }
  if (pending.length) {
    const usable = width - (pending.length - 1) * gap;
    rows.push({ items: pending, height: Math.min(usable / sumRatio, target) });
  }
  return rows;
}

/** 按原始宽高比分行，DOM 顺序 = 时间顺序 = 灯箱翻页顺序，图片绝不裁切。 */
function layoutJustifiedRows(container) {
  const figures = [...container.querySelectorAll('.photo')];
  if (!figures.length) return;
  for (const row of container.querySelectorAll('.row')) {
    row.replaceWith(...[...row.children]);
  }
  const width = container.clientWidth;
  if (!width) return;
  const { target, gap } = layoutMetrics();
  const rows = computeRows(
    figures.map((figure) => ({ figure, ratio: figure.dataset.ratio })),
    width, target, gap,
  );

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    rowEl.style.height = `${row.height}px`;
    rowEl.style.marginBottom = `${gap}px`;
    for (const item of row.items) {
      item.figure.style.flexGrow = String(item.ratio);
      item.figure.style.flexBasis = '0';
      item.figure.style.height = `${row.height}px`;
      item.figure.style.aspectRatio = 'auto';
      rowEl.appendChild(item.figure);
    }
    fragment.appendChild(rowEl);
  }
  container.appendChild(fragment);
}

function layoutAll() {
  if (resizeObserver) resizeObserver.disconnect();
  const containers = [...document.querySelectorAll('.justified')];
  if (!containers.length) return;
  if (typeof ResizeObserver === 'undefined') {
    for (const container of containers) container.classList.add('is-fallback');
    return;
  }
  for (const container of containers) layoutJustifiedRows(container);
  resizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const width = Math.round(entry.contentRect.width);
      if (widthMemo.get(entry.target) !== width) {
        widthMemo.set(entry.target, width);
        changed = true;
      }
    }
    if (!changed) return;
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      for (const container of document.querySelectorAll('.justified')) {
        layoutJustifiedRows(container);
      }
    }, 100);
  });
  for (const container of containers) {
    widthMemo.set(container, Math.round(container.clientWidth));
    resizeObserver.observe(container);
  }
}

function observeReveal() {
  if (REDUCED_MOTION.matches || typeof IntersectionObserver === 'undefined') return;
  if (revealObserver) revealObserver.disconnect();
  revealObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }
  }, { rootMargin: '0px 0px -40px 0px', threshold: 0.02 });
  for (const node of document.querySelectorAll('.reveal:not(.is-visible)')) {
    revealObserver.observe(node);
  }
}

function observeImages() {
  for (const img of document.querySelectorAll('.photo img, .album-card img')) {
    if (img.complete) img.classList.add('is-loaded');
    else img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
  }
}

function render() {
  if (!state.data) return;
  state.filtered = state.data.photos.filter(matches);
  el('photo-count').textContent = `${state.filtered.length} / ${state.data.photos.length} 张照片`;

  const content = el('content');
  let html = '';
  if (state.view === 'album' && state.album) {
    html += `<button type="button" class="back" id="back">&larr; 全部相册</button>`;
  }
  if (state.view === 'album' && !state.album) {
    html += albumCardsHtml(state.filtered);
  } else if (!state.filtered.length) {
    html += `<div class="empty"><p>没有找到符合条件的照片</p>
      <button type="button" id="empty-clear">清除筛选</button></div>`;
  } else {
    html += timelineHtml(state.filtered);
  }
  content.innerHTML = html;
  bindContentEvents();
  observeImages();
  layoutAll();
  observeReveal();
}

function bindContentEvents() {
  const back = el('back');
  if (back) {
    back.addEventListener('click', () => {
      state.album = '';
      render();
      syncUrl(true);
    });
  }

  const emptyClear = el('empty-clear');
  if (emptyClear) emptyClear.addEventListener('click', clearFilters);

  for (const card of document.querySelectorAll('.album-card')) {
    card.addEventListener('click', () => {
      state.album = card.dataset.album;
      render();
      syncUrl(true);
      window.scrollTo({ top: 0, behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' });
    });
  }

  for (const img of document.querySelectorAll('.photo img')) {
    img.addEventListener('click', () => openLightbox(Number(img.dataset.idx)));
    img.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openLightbox(Number(img.dataset.idx));
      }
    });
  }
}

function fillSelect(id, values, formatter = String) {
  const select = el(id);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = formatter(value);
    select.appendChild(option);
  }
}

function buildFilterOptions() {
  const tags = new Set();
  const years = new Set();
  for (const photo of state.data.photos) {
    photo.tags.forEach((tag) => tags.add(tag));
    years.add(photo.year);
  }
  fillSelect('tag', [...tags].sort((a, b) => a.localeCompare(b)));
  fillSelect('year', [...years].sort((a, b) => b - a));
  fillSelect('month', Array.from({ length: 12 }, (_, i) => i + 1), (m) => `${m} 月`);
}

function clearFilters() {
  state.q = ''; state.tag = ''; state.year = ''; state.month = '';
  syncInputs();
  render();
  syncUrl(true);
}

function fillStory() {
  const photos = state.data.photos;
  el('story-photos').textContent = String(photos.length);
  el('story-albums').textContent = String(state.data.albums.length);
  if (!photos.length) {
    el('story-span').textContent = '—';
    return;
  }
  const years = photos.map((photo) => photo.year);
  const min = Math.min(...years);
  const max = Math.max(...years);
  el('story-span').textContent = min === max ? String(min) : `${min}–${max}`;
}

let toastTimer = null;
function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

/* ---------- Lightbox ---------- */
function preload(index) {
  const photo = state.filtered[index];
  if (!photo) return;
  const image = new Image();
  image.src = photo.view;
}

function applyZoom() {
  const { zoom, panX, panY } = state.lightbox;
  el('lb-image').style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  el('lb-zoom').textContent = zoom > 1 ? '−' : '+';
  el('lb-zoom').setAttribute('aria-label', zoom > 1 ? '缩小' : '放大');
}

function resetZoom() {
  state.lightbox.zoom = 1;
  state.lightbox.panX = 0;
  state.lightbox.panY = 0;
  applyZoom();
}

function cycleZoom() {
  const zoom = state.lightbox.zoom;
  state.lightbox.zoom = zoom >= 3 ? 1 : Math.min(3, zoom + 1);
  if (state.lightbox.zoom === 1) resetZoom();
  else applyZoom();
}

function renderThumbs() {
  const holder = el('lb-thumbs');
  holder.innerHTML = state.filtered.map((photo, index) => `
    <button type="button" data-idx="${index}" aria-label="第 ${index + 1} 张">
      <img src="${escapeHtml(photo.thumb)}" alt="" loading="lazy">
    </button>`).join('');
  for (const button of holder.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.idx);
      if (index === state.lightbox.index) return;
      state.lightbox.index = index;
      showLightboxImage();
      syncUrl(false);
    });
  }
}

function highlightThumb() {
  const holder = el('lb-thumbs');
  for (const button of holder.querySelectorAll('button.is-current')) {
    button.classList.remove('is-current');
  }
  const button = holder.querySelector(`button[data-idx="${state.lightbox.index}"]`);
  if (!button) return;
  button.classList.add('is-current');
  button.scrollIntoView({
    inline: 'center', block: 'nearest',
    behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth',
  });
}

function showLightboxImage() {
  const photo = state.filtered[state.lightbox.index];
  if (!photo) return;
  const image = el('lb-image');
  image.src = photo.view;
  image.alt = photoAlt(photo);
  el('lb-meta').textContent = [
    photo.title, photo.album, `${photo.year}年${photo.month}月`, photo.caption,
  ].filter(Boolean).join(' · ');
  el('lb-counter').textContent = `第 ${state.lightbox.index + 1} / 共 ${state.filtered.length} 张`;
  resetZoom();
  preload(state.lightbox.index + 1);
  preload(state.lightbox.index - 1);
  highlightThumb();
}

function step(delta) {
  const total = state.filtered.length;
  if (!total) return;
  state.lightbox.index = (state.lightbox.index + delta + total) % total;
  showLightboxImage();
  syncUrl(false);
}

function stopPlay() {
  if (state.lightbox.timer) {
    clearInterval(state.lightbox.timer);
    state.lightbox.timer = null;
  }
  el('lb-play').innerHTML = '&#9654;&nbsp; 自动播放';
}

function togglePlay() {
  if (state.lightbox.timer) {
    stopPlay();
  } else {
    state.lightbox.timer = setInterval(() => step(1), PLAY_INTERVAL);
    el('lb-play').innerHTML = '&#9208;&nbsp; 暂停';
  }
}

function openLightbox(index, options = {}) {
  if (!state.filtered[index]) return;
  state.lightbox.lastFocus = document.activeElement;
  state.lightbox.index = index;
  el('lightbox').hidden = false;
  document.body.classList.add('lb-open');
  renderThumbs();
  showLightboxImage();
  el('lb-close').focus();
  if (options.sync !== false) syncUrl(true);
}

function closeLightbox(options = {}) {
  stopPlay();
  const wasOpen = !el('lightbox').hidden;
  el('lightbox').hidden = true;
  document.body.classList.remove('lb-open');
  el('lb-image').removeAttribute('src');
  el('lb-thumbs').innerHTML = '';
  resetZoom();
  if (options.restore !== false && state.lightbox.lastFocus && state.lightbox.lastFocus.focus) {
    state.lightbox.lastFocus.focus();
  }
  state.lightbox.index = -1;
  if (wasOpen && options.sync !== false) syncUrl(true);
}

function pinchDistance(touches) {
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  ) || 1;
}

/* ---------- Global events ---------- */
function bindGlobalEvents() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.view = tab.dataset.view;
      state.album = '';
      syncInputs();
      render();
      syncUrl(true);
    });
  }

  el('q').addEventListener('input', (event) => {
    state.q = event.target.value.trim();
    render();
    syncUrl(false);
  });
  el('tag').addEventListener('change', (event) => {
    state.tag = event.target.value; render(); syncUrl(false);
  });
  el('year').addEventListener('change', (event) => {
    state.year = event.target.value; render(); syncUrl(false);
  });
  el('month').addEventListener('change', (event) => {
    state.month = event.target.value; render(); syncUrl(false);
  });
  el('clear').addEventListener('click', clearFilters);

  el('lb-close').addEventListener('click', () => closeLightbox());
  el('lb-prev').addEventListener('click', () => step(-1));
  el('lb-next').addEventListener('click', () => step(1));
  el('lb-play').addEventListener('click', togglePlay);
  el('lb-zoom').addEventListener('click', cycleZoom);

  const box = el('lightbox');
  const figure = el('lb-figure');
  const image = el('lb-image');

  box.addEventListener('click', (event) => {
    if (event.target === box || event.target === figure) closeLightbox();
  });

  figure.addEventListener('wheel', (event) => {
    if (box.hidden) return;
    event.preventDefault();
    const zoom = state.lightbox.zoom;
    const next = event.deltaY < 0 ? Math.min(3, zoom + 0.25) : Math.max(1, zoom - 0.25);
    state.lightbox.zoom = Number(next.toFixed(2));
    if (next <= 1) resetZoom();
    else applyZoom();
  }, { passive: false });

  image.addEventListener('dblclick', () => {
    if (state.lightbox.zoom > 1) resetZoom();
    else { state.lightbox.zoom = 2; applyZoom(); }
  });

  let drag = null;
  image.addEventListener('pointerdown', (event) => {
    if (state.lightbox.zoom <= 1) return;
    drag = {
      x: event.clientX, y: event.clientY,
      panX: state.lightbox.panX, panY: state.lightbox.panY,
    };
    image.setPointerCapture(event.pointerId);
    image.classList.add('is-grabbing');
  });
  image.addEventListener('pointermove', (event) => {
    if (!drag) return;
    state.lightbox.panX = drag.panX + event.clientX - drag.x;
    state.lightbox.panY = drag.panY + event.clientY - drag.y;
    applyZoom();
  });
  const endDrag = () => { drag = null; image.classList.remove('is-grabbing'); };
  image.addEventListener('pointerup', endDrag);
  image.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (event) => {
    if (box.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    else if (event.key === ' ') { event.preventDefault(); togglePlay(); }
  });

  box.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      state.lightbox.pinch = { dist: pinchDistance(event.touches), zoom: state.lightbox.zoom };
      state.lightbox.touchX = null;
    } else if (event.touches.length === 1) {
      state.lightbox.touchX = event.changedTouches[0].clientX;
    }
  }, { passive: true });

  box.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 2 || !state.lightbox.pinch) return;
    const ratio = pinchDistance(event.touches) / state.lightbox.pinch.dist;
    state.lightbox.zoom = Math.max(1, Math.min(3, state.lightbox.pinch.zoom * ratio));
    if (state.lightbox.zoom <= 1) { state.lightbox.panX = 0; state.lightbox.panY = 0; }
    applyZoom();
  }, { passive: true });

  box.addEventListener('touchend', (event) => {
    if (state.lightbox.pinch) {
      state.lightbox.pinch = null;
      state.lightbox.touchX = null;
      return;
    }
    const start = state.lightbox.touchX;
    state.lightbox.touchX = null;
    if (start === null || state.lightbox.zoom > 1) return;
    const delta = event.changedTouches[0].clientX - start;
    if (Math.abs(delta) > 40) step(delta < 0 ? 1 : -1);
  }, { passive: true });

  const onHistoryChange = () => {
    if (location.hash === lastAppliedHash) return;
    applyHash();
  };
  window.addEventListener('popstate', onHistoryChange);
  window.addEventListener('hashchange', onHistoryChange);
}

/* ---------- Init ---------- */
async function init() {
  if (!REDUCED_MOTION.matches) document.documentElement.classList.add('js-anim');
  for (const node of document.querySelectorAll('.catalog-head, .story-title, .stat')) {
    node.classList.add('reveal');
  }
  observeReveal();

  try {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();

    document.title = state.data.site.title;
    el('site-title').textContent = state.data.site.title;
    el('site-subtitle').textContent = state.data.site.subtitle || DEFAULT_SUBTITLE;
    el('footer-meta').textContent =
      `${state.data.photos.length} 张照片 · ${state.data.albums.length} 个相册`;

    fillStory();
    buildFilterOptions();
    bindGlobalEvents();
    applyHash();
  } catch (err) {
    el('content').innerHTML =
      `<div class="empty"><p>照片清单加载失败</p><p>${escapeHtml(err.message)}</p></div>`;
  }
}

if (typeof document !== 'undefined') init();
