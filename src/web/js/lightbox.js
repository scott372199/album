import { state, PLAY_INTERVAL } from './state.js';
import { el, photoAlt, reducedMotion } from './ui.js';

const refs = {};
let list = [];
let hooks = { onNavigate: () => {}, onClose: () => {} };
let playTimer = null;
let opened = false;
let thumbsBuilt = false;

function cache() {
  if (refs.root) return refs;
  Object.assign(refs, {
    root: el('lightbox'),
    image: el('lb-image'),
    video: el('lb-video'),
    counter: el('lb-counter'),
    meta: el('lb-meta'),
    thumbs: el('lb-thumbs'),
    zoom: el('lb-zoom'),
    play: el('lb-play'),
    mute: el('lb-mute'),
    figure: el('lb-figure'),
    prev: el('lb-prev'),
    next: el('lb-next'),
    closeBtn: el('lb-close'),
  });
  return refs;
}

function current() {
  return list[state.lightbox.index] || null;
}

function isMotion(photo) {
  return photo && (photo.type === 'video' || photo.type === 'live' || photo.type === 'animation') && photo.src;
}

function resetZoom() {
  state.lightbox.zoom = 1;
  state.lightbox.panX = 0;
  state.lightbox.panY = 0;
  applyTransform();
}

function applyTransform() {
  const { image } = cache();
  const { zoom, panX, panY } = state.lightbox;
  image.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  image.classList.toggle('is-zoomed', zoom > 1);
}

function setZoom(next) {
  state.lightbox.zoom = Math.min(3, Math.max(1, next));
  if (state.lightbox.zoom === 1) {
    state.lightbox.panX = 0;
    state.lightbox.panY = 0;
  }
  applyTransform();
}

function stopAutoplay() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
  const { play } = cache();
  if (play) {
    play.textContent = '自动播放';
    play.classList.remove('is-on');
  }
}

function startAutoplay() {
  stopAutoplay();
  if (reducedMotion.matches) return;
  const { play } = cache();
  play.textContent = '停止播放';
  play.classList.add('is-on');
  playTimer = setInterval(() => navigate(1, { wrap: true }), PLAY_INTERVAL);
}

function prefetch(index) {
  const photo = list[index];
  if (!photo) return;
  if (isMotion(photo)) return;
  const img = new Image();
  img.src = photo.view || photo.grid;
}

function renderThumbs() {
  const { thumbs } = cache();
  if (thumbsBuilt) return;
  const fragment = document.createDocumentFragment();
  list.forEach((photo, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = String(index);
    button.setAttribute('aria-label', photoAlt(photo));
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = photo.thumb || photo.poster || '';
    button.appendChild(img);
    if (photo.type === 'video' || photo.type === 'live') {
      const dot = document.createElement('span');
      dot.className = 'thumb-play';
      dot.textContent = '▶';
      button.appendChild(dot);
    }
    button.addEventListener('click', () => show(index));
    fragment.appendChild(button);
  });
  thumbs.replaceChildren(fragment);
  thumbsBuilt = true;
}

function updateThumbState() {
  const { thumbs } = cache();
  for (const button of thumbs.children) {
    const active = Number(button.dataset.index) === state.lightbox.index;
    button.classList.toggle('is-current', active);
    if (active) button.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
}

function show(index) {
  if (!list.length) return;
  const total = list.length;
  state.lightbox.index = ((index % total) + total) % total;
  const photo = current();
  const r = cache();

  r.image.hidden = false;
  r.video.hidden = true;
  r.video.pause();
  r.video.removeAttribute('src');
  r.video.load?.();

  if (isMotion(photo)) {
    r.image.hidden = true;
    r.video.hidden = false;
    r.video.src = photo.src;
    r.video.poster = photo.poster || '';
    r.video.currentTime = 0;
    const attempt = r.video.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    r.mute.hidden = false;
    r.mute.textContent = r.video.muted ? '取消静音' : '静音';
    r.play.hidden = true;
  } else {
    r.image.src = photo.view || photo.grid || photo.poster || '';
    r.image.alt = photoAlt(photo);
    r.mute.hidden = true;
    r.play.hidden = false;
  }

  r.counter.textContent = `${state.lightbox.index + 1} / ${total}`;
  const bits = [photoAlt(photo)];
  if (photo.caption) bits.push(photo.caption);
  r.meta.textContent = bits.filter(Boolean).join(' · ');

  r.prev.hidden = total <= 1;
  r.next.hidden = total <= 1;

  resetZoom();
  renderThumbs();
  updateThumbState();
  prefetch(state.lightbox.index + 1);
  prefetch(state.lightbox.index - 1);
  hooks.onNavigate(photo);
}

export function navigate(delta, { wrap = false } = {}) {
  if (!list.length) return;
  const next = state.lightbox.index + delta;
  if (!wrap && (next < 0 || next >= list.length)) return;
  show(next);
}

export function openLightbox(photos, index = 0) {
  list = photos;
  thumbsBuilt = false;
  cache();
  const r = refs;
  state.lightbox.lastFocus = document.activeElement;
  opened = true;
  r.root.hidden = false;
  document.body.classList.add('lb-open');
  show(index);
  r.closeBtn.focus({ preventScroll: true });
}

export function closeLightbox() {
  if (!opened) return;
  opened = false;
  stopAutoplay();
  const r = cache();
  r.video.pause();
  r.video.removeAttribute('src');
  r.root.hidden = true;
  document.body.classList.remove('lb-open');
  state.lightbox.index = -1;
  resetZoom();
  thumbsBuilt = false;
  r.thumbs.replaceChildren();
  if (state.lightbox.lastFocus && state.lightbox.lastFocus.focus) {
    state.lightbox.lastFocus.focus({ preventScroll: true });
  }
  hooks.onClose();
}

export function isLightboxOpen() {
  return opened;
}

export function currentPhoto() {
  return current();
}

/* ---------- 交互 ---------- */

export function initLightbox(hooksIn = {}) {
  hooks = { ...hooks, ...hooksIn };
  const r = cache();

  r.closeBtn.addEventListener('click', closeLightbox);
  r.prev.addEventListener('click', () => navigate(-1));
  r.next.addEventListener('click', () => navigate(1));

  r.zoom.addEventListener('click', () => setZoom(state.lightbox.zoom >= 3 ? 1 : state.lightbox.zoom + 1));
  r.play.addEventListener('click', () => (playTimer ? stopAutoplay() : startAutoplay()));
  r.mute.addEventListener('click', () => {
    r.video.muted = !r.video.muted;
    r.mute.textContent = r.video.muted ? '取消静音' : '静音';
  });

  r.image.addEventListener('dblclick', () => setZoom(state.lightbox.zoom > 1 ? 1 : 2));

  // 缩放后的拖动平移
  let dragging = null;
  r.image.addEventListener('pointerdown', (event) => {
    if (state.lightbox.zoom === 1) return;
    dragging = { x: event.clientX, y: event.clientY, panX: state.lightbox.panX, panY: state.lightbox.panY };
    r.image.setPointerCapture(event.pointerId);
    r.image.classList.add('is-grabbing');
  });
  r.image.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    state.lightbox.panX = dragging.panX + (event.clientX - dragging.x);
    state.lightbox.panY = dragging.panY + (event.clientY - dragging.y);
    applyTransform();
  });
  const endDrag = () => {
    dragging = null;
    r.image.classList.remove('is-grabbing');
  };
  r.image.addEventListener('pointerup', endDrag);
  r.image.addEventListener('pointercancel', endDrag);

  // 触摸：单指横向翻页 / 双指缩放
  let startX = null;
  let pinch = null;
  r.figure.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      pinch = { distance: touchDistance(event.touches), zoom: state.lightbox.zoom };
      return;
    }
    if (event.touches.length === 1 && state.lightbox.zoom === 1) startX = event.touches[0].clientX;
  }, { passive: true });

  r.figure.addEventListener('touchmove', (event) => {
    if (event.touches.length === 2 && pinch) {
      const next = pinch.zoom * (touchDistance(event.touches) / pinch.distance);
      setZoom(next);
    }
  }, { passive: true });

  r.figure.addEventListener('touchend', (event) => {
    if (pinch) { pinch = null; return; }
    if (startX === null) return;
    const endX = event.changedTouches[0].clientX;
    const delta = endX - startX;
    startX = null;
    if (Math.abs(delta) < 50) return;
    navigate(delta < 0 ? 1 : -1);
  }, { passive: true });

  r.video.addEventListener('ended', () => {
    if (state.lightbox.index < 0) return;
    navigate(1, { wrap: true });
  });

  document.addEventListener('keydown', (event) => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); return; }
    if (event.key === ' ') {
      event.preventDefault();
      if (isMotion(current())) {
        if (r.video.paused) r.video.play().catch(() => {});
        else r.video.pause();
      } else if (playTimer) {
        stopAutoplay();
      } else {
        startAutoplay();
      }
      return;
    }
    if (event.key === '+' || event.key === '=') setZoom(state.lightbox.zoom + 1);
    if (event.key === '-') setZoom(state.lightbox.zoom - 1);
  });
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy) || 1;
}
