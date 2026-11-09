import { buildStory, PACE } from './state.js';
import { el, photoAlt, reducedMotion, markWhenReady } from './ui.js';

const CARD_MS = 2200;
const MAX_VIDEO_MS = 32000;

const s = {
  chapters: [],
  slides: [],
  index: 0,
  chapter: 0,
  paused: false,
  timer: null,
  dueAt: 0,
  remaining: 0,
  layer: 'a',
  pace: 'normal',
  active: false,
  node: null,
  hooks: {},
};

const refs = {};

function cache() {
  if (refs.root) return refs;
  Object.assign(refs, {
    root: el('story'),
    stage: el('story-stage'),
    card: el('story-card'),
    cardIndex: el('story-card-index'),
    cardTitle: el('story-card-title'),
    cardSub: el('story-card-sub'),
    end: el('story-end'),
    endStats: el('story-end-stats'),
    chapter: el('story-chapter'),
    progress: el('story-progress'),
    pace: el('story-pace'),
    pause: el('story-pause'),
    close: el('story-close'),
    replay: el('story-replay'),
    exit: el('story-exit'),
  });
  return refs;
}

function isMotion(photo) {
  return (photo.type === 'video' || photo.type === 'live' || photo.type === 'animation') && photo.src;
}

function durationFor(photo) {
  if (isMotion(photo)) {
    return Math.min(Number(photo.duration || 8) * 1000, MAX_VIDEO_MS) || 8000;
  }
  const base = PACE[s.pace] || PACE.normal;
  const extra = (Number(photo.ratio) || 1) < 0.9 ? 600 : 0;
  const captionBonus = photo.title || photo.caption ? 800 : 0;
  return base + extra + captionBonus;
}

function clearTimer() {
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
}

function schedule(ms) {
  clearTimer();
  s.dueAt = performance.now() + ms;
  s.timer = setTimeout(() => {
    s.timer = null;
    next();
  }, ms);
}

function pause() {
  if (!s.active || s.paused) return;
  s.paused = true;
  if (s.timer) {
    s.remaining = Math.max(400, s.dueAt - performance.now());
    clearTimer();
  }
  const video = s.node?.querySelector('video');
  if (video) video.pause();
  refs.pause.textContent = '继续';
  refs.root.classList.add('is-paused');
}

function resume() {
  if (!s.active || !s.paused) return;
  s.paused = false;
  refs.pause.textContent = '暂停';
  refs.root.classList.remove('is-paused');
  const video = s.node?.querySelector('video');
  if (video) {
    video.play().catch(() => {});
    return;
  }
  schedule(s.remaining > 0 ? s.remaining : durationFor(currentPhoto()));
}

function currentPhoto() {
  return s.slides[s.index]?.photo || null;
}

function chapterOf(index) {
  return s.slides[index]?.chapter ?? 0;
}

function updateBar() {
  const total = s.slides.length || 1;
  refs.progress.style.width = `${((s.index + 1) / total) * 100}%`;
  const chapter = s.chapters[s.chapter];
  refs.chapter.textContent = chapter ? `${chapter.label} · ${s.index + 1}/${total}` : '';
}

function makeSlide(photo) {
  const layer = document.createElement('div');
  layer.className = 'story-slide';
  layer.style.setProperty('--kb', `${reducedMotion.matches ? 1 : 10000 + (s.index % 3) * 1500}ms`);

  if (isMotion(photo)) {
    const video = document.createElement('video');
    video.src = photo.src;
    video.poster = photo.poster || '';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    markWhenReady(video, layer);
    video.addEventListener('loadeddata', () => { video.play().catch(() => {}); }, { once: true });
    video.addEventListener('ended', () => {
      if (s.active && !s.paused) next();
    });
    layer.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.className = 'story-img';
    img.alt = photoAlt(photo);
    img.decoding = 'async';
    img.src = photo.view || photo.grid || photo.poster || '';
    markWhenReady(img, layer);
    layer.appendChild(img);
  }

  return layer;
}

function showSlide(index) {
  const photo = s.slides[index]?.photo;
  if (!photo) return;

  s.index = index;
  s.chapter = chapterOf(index);
  updateBar();

  const previous = s.node;
  const layer = makeSlide(photo);
  const direction = s.layer === 'a' ? 'b' : 'a';
  s.layer = direction;
  layer.dataset.layer = direction;
  refs.stage.appendChild(layer);
  requestAnimationFrame(() => layer.classList.add('is-active'));
  s.node = layer;

  // 下一层进入后移除旧层，最多同时存在 2 层
  if (previous) {
    previous.classList.remove('is-active');
    setTimeout(() => previous.remove(), 1000);
  }

  const video = layer.querySelector('video');
  if (video) {
    const guard = Math.min((Number(photo.duration) || 10) * 1000 + 1500, MAX_VIDEO_MS);
    if (!s.paused) schedule(guard);
  } else if (!s.paused) {
    schedule(durationFor(photo));
  }

  // 预热下一张
  const nextPhoto = s.slides[index + 1]?.photo;
  if (nextPhoto && !isMotion(nextPhoto)) {
    const img = new Image();
    img.src = nextPhoto.view || nextPhoto.grid;
  }
}

function showCard(chapter) {
  const r = cache();
  r.card.hidden = false;
  r.cardIndex.textContent = String(s.chapters.indexOf(chapter) + 1).padStart(2, '0');
  r.cardTitle.textContent = chapter.label;
  r.cardSub.textContent = `${chapter.items.length} 张`;
  r.card.classList.add('is-visible');

  clearTimer();
  s.dueAt = performance.now() + CARD_MS;
  s.timer = setTimeout(() => {
    r.card.classList.remove('is-visible');
    setTimeout(() => { r.card.hidden = true; }, 500);
    showSlide(s.index);
  }, CARD_MS);
}

function next() {
  if (!s.active || s.paused) return;
  const nextIndex = s.index + 1;
  if (nextIndex >= s.slides.length) {
    finish();
    return;
  }
  const nextChapter = chapterOf(nextIndex);
  if (nextChapter !== s.chapter) {
    s.chapter = nextChapter;
    s.index = nextIndex;
    showCard(s.chapters[nextChapter]);
    return;
  }
  showSlide(nextIndex);
}

function prev() {
  if (!s.active) return;
  const target = Math.max(0, s.index - 1);
  s.chapter = chapterOf(target);
  showSlide(target);
}

function jumpChapter(delta) {
  if (!s.active) return;
  const target = Math.min(s.chapters.length - 1, Math.max(0, s.chapter + delta));
  const first = s.slides.findIndex((slide) => slide.chapter === target);
  if (first >= 0) {
    s.chapter = target;
    showCard(s.chapters[target]);
    s.index = first;
  }
}

function finish() {
  clearTimer();
  const r = cache();
  r.end.hidden = false;
  r.end.classList.add('is-visible');
  const years = s.slides.map((slide) => slide.photo.year);
  const min = Math.min(...years);
  const max = Math.max(...years);
  r.endStats.textContent = `${s.slides.length} 张 · ${s.chapters.length} 章 · ${min === max ? min : `${min}–${max}`}`;
  r.pause.hidden = true;
}

function resetStage() {
  for (const layer of refs.stage.querySelectorAll('.story-slide')) layer.remove();
  s.node = null;
}

export function openStory(list, { onClose, pace = 'normal' } = {}) {
  if (!list.length) return;
  const r = cache();
  s.hooks.onClose = onClose || (() => {});
  s.pace = PACE[pace] ? pace : 'normal';
  s.active = true;
  s.paused = false;
  s.layer = 'a';
  s.remaining = 0;
  s.index = 0;

  const { chapters } = buildStory(list);
  s.chapters = chapters;
  s.slides = [];
  chapters.forEach((chapter, chapterIndex) => {
    chapter.items.forEach((photo) => s.slides.push({ photo, chapter: chapterIndex }));
  });
  if (!s.slides.length) return;

  resetStage();
  r.end.hidden = true;
  r.end.classList.remove('is-visible');
  r.pause.hidden = false;
  r.pause.textContent = '暂停';
  r.pace.textContent = { slow: '慢', normal: '标准', fast: '快' }[s.pace];
  r.root.hidden = false;
  r.root.classList.remove('is-paused');
  document.body.classList.add('story-open');

  const firstChapter = s.chapters[0];
  updateBar();
  if (firstChapter) showCard(firstChapter);
}

export function closeStory() {
  if (!s.active) return;
  s.active = false;
  clearTimer();
  const r = cache();
  r.root.hidden = true;
  document.body.classList.remove('story-open');
  resetStage();
  r.card.hidden = true;
  r.end.hidden = true;
  s.hooks.onClose();
}

export function isStoryOpen() {
  return s.active;
}

export function initStory() {
  const r = cache();

  r.close.addEventListener('click', (event) => { event.stopPropagation(); closeStory(); });
  r.exit.addEventListener('click', () => closeStory());
  r.replay.addEventListener('click', () => {
    s.index = 0;
    s.chapter = 0;
    r.end.hidden = true;
    r.pause.hidden = false;
    showCard(s.chapters[0]);
  });
  r.pause.addEventListener('click', () => (s.paused ? resume() : pause()));
  r.pace.addEventListener('click', () => {
    const order = ['slow', 'normal', 'fast'];
    s.pace = order[(order.indexOf(s.pace) + 1) % order.length];
    r.pace.textContent = { slow: '慢', normal: '标准', fast: '快' }[s.pace];
    if (!s.paused) schedule(durationFor(currentPhoto()));
  });

  r.stage.addEventListener('click', (event) => {
    if (event.target.closest('.story-end-actions')) return;
    s.paused ? resume() : pause();
  });

  document.addEventListener('keydown', (event) => {
    if (!s.active) return;
    if (event.key === 'Escape') { event.preventDefault(); closeStory(); return; }
    if (event.key === ' ') {
      event.preventDefault();
      s.paused ? resume() : pause();
      return;
    }
    if (event.key === 'ArrowRight') { event.preventDefault(); next(); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); prev(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); jumpChapter(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); jumpChapter(-1); }
  });

  // 切到后台就暂停，避免回来时「进度已经跑完」
  document.addEventListener('visibilitychange', () => {
    if (!s.active) return;
    if (document.visibilityState === 'hidden') pause();
  });
}
