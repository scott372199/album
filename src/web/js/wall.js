import { el, clockParts, inNightWindow, shuffle, reducedMotion, markWhenReady } from './ui.js';
import { startVersionWatch } from './update.js';
import { setKeepScreenOn } from './native.js';

const MAX_VIDEO_MS = 45000;

const w = {
  active: false,
  photos: [],
  queue: [],
  index: 0,
  layer: 'a',
  node: null,
  timer: null,
  dueAt: 0,
  remaining: 0,
  playing: true,
  interval: 10,
  clock: true,
  nightWindow: { from: '22:00', to: '07:00' },
  nightForced: null,
  wake: null,
  wantWake: false,
  clockTimer: null,
  watch: null,
  barTimer: null,
  hooks: {},
  rev: null,
  dayKey: '',
};

const refs = {};

function cache() {
  if (refs.root) return refs;
  Object.assign(refs, {
    root: el('wall'),
    stage: el('wall-stage'),
    clock: el('wall-clock'),
    time: el('wall-time'),
    date: el('wall-date'),
    hint: el('wall-hint'),
    bar: el('wall-bar'),
    prev: el('wall-prev'),
    next: el('wall-next'),
    toggle: el('wall-toggle'),
    interval: el('wall-interval'),
    clockToggle: el('wall-clock-toggle'),
    night: el('wall-night'),
    exit: el('wall-exit'),
  });
  return refs;
}

function isMotion(photo) {
  return (photo.type === 'video' || photo.type === 'live' || photo.type === 'animation') && photo.src;
}

/* ---------- 队列 ---------- */

function buildQueue(photos, now) {
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const sameMonth = photos.filter((photo) => photo.month === month && photo.year < year);
  const recent = photos.slice(0, 24);
  const seen = new Set([...sameMonth.map((p) => p.id), ...recent.map((p) => p.id)]);
  const rest = shuffle(photos.filter((p) => !seen.has(p.id)));

  const head = [];
  const used = new Set();
  for (const photo of [...sameMonth.slice(0, 8), ...recent, ...rest]) {
    if (used.has(photo.id)) continue;
    used.add(photo.id);
    head.push(photo);
  }
  return head;
}

/* ---------- 渲染 ---------- */

function makeLayer(photo) {
  const layer = document.createElement('div');
  layer.className = 'wall-slide';
  layer.style.setProperty('--kb', `${reducedMotion.matches ? 1 : 18000 + (w.index % 4) * 3000}ms`);

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
      if (w.active && w.playing) next();
    });
    layer.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = photo.view || photo.grid || photo.poster || '';
    markWhenReady(img, layer);
    layer.appendChild(img);
  }
  return layer;
}

function schedule(ms) {
  clearTimeout(w.timer);
  w.dueAt = performance.now() + ms;
  w.timer = setTimeout(() => {
    w.timer = null;
    next();
  }, ms);
}

function durationFor(photo) {
  if (isMotion(photo)) {
    return Math.min((Number(photo.duration) || 8) * 1000 + 1200, MAX_VIDEO_MS);
  }
  return Math.max(3000, w.interval * 1000);
}

function show(index) {
  if (!w.queue.length) return;
  const total = w.queue.length;
  w.index = ((index % total) + total) % total;
  const photo = w.queue[w.index];

  const previous = w.node;
  const layer = makeLayer(photo);
  w.layer = w.layer === 'a' ? 'b' : 'a';
  layer.dataset.layer = w.layer;
  refs.stage.appendChild(layer);
  requestAnimationFrame(() => layer.classList.add('is-active'));
  w.node = layer;

  if (previous) {
    previous.classList.remove('is-active');
    setTimeout(() => previous.remove(), 1400);
  }

  // 预热下一张的封面
  const nextPhoto = w.queue[(w.index + 1) % total];
  if (nextPhoto && !isMotion(nextPhoto)) {
    const img = new Image();
    img.src = nextPhoto.view || nextPhoto.grid;
  }

  if (w.playing) schedule(durationFor(photo));
}

function next() {
  if (!w.active) return;
  show(w.index + 1);
}

function prev() {
  if (!w.active) return;
  show(w.index - 1);
}

/* ---------- 时钟与夜间 ---------- */

function isNight() {
  if (w.nightForced !== null) return w.nightForced;
  return inNightWindow(new Date(), w.nightWindow.from, w.nightWindow.to);
}

function updateClock() {
  const now = new Date();
  const parts = clockParts(now);
  refs.time.textContent = parts.time;
  refs.date.textContent = `${parts.date} ${parts.weekday}`;
  refs.root.classList.toggle('is-night', isNight());
  refs.night.textContent = isNight() ? '夜间 开' : '夜间';

  // 防烧屏：每小时把时钟挪 1px
  const offset = (now.getHours() % 2 === 0) ? 1 : -1;
  refs.clock.style.transform = `translate(${offset}px, ${offset}px)`;

  const dayKey = now.toDateString();
  if (dayKey !== w.dayKey) {
    w.dayKey = dayKey;
    rebuildQueue(false);
  }
}

/* ---------- Wake Lock ---------- */

async function acquireWake() {
  // 安卓 WebView 里先问原生：WebView 的 Wake Lock 经常被系统直接拒，
  // 原生侧持有 FLAG_KEEP_SCREEN_ON 才是可靠的。
  // Ask the native side first inside an Android WebView: its Wake Lock is often
  // refused outright, while FLAG_KEEP_SCREEN_ON on the native side is reliable.
  if (setKeepScreenOn(true)) {
    w.wantWake = true;
    if (refs.hint) refs.hint.hidden = true;
    return;
  }
  if (!('wakeLock' in navigator)) {
    showHint('当前浏览器不支持保持常亮，请用 Safari 打开并参考系统设置。');
    return;
  }
  try {
    w.wake = await navigator.wakeLock.request('screen');
    w.wantWake = true;
    w.wake.addEventListener('release', () => {
      w.wake = null;
      if (w.wantWake && w.active && document.visibilityState === 'visible') {
        setTimeout(acquireWake, 1200);
      }
    });
    if (refs.hint) refs.hint.hidden = true;
  } catch (err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError') {
      showHint('常亮被系统拒绝：需要 HTTPS 地址、且不要用「添加到主屏幕」的独立窗口。');
    } else {
      showHint('当前环境无法保持常亮，已改为普通轮播。');
    }
  }
}

function releaseWake() {
  w.wantWake = false;
  setKeepScreenOn(false);
  if (w.wake) {
    try { w.wake.release(); } catch { /* 忽略 */ }
    w.wake = null;
  }
}

function showHint(text) {
  const r = cache();
  r.hint.textContent = text;
  r.hint.hidden = false;
}

/* ---------- 控制条 ---------- */

function showBar() {
  const r = cache();
  r.bar.classList.add('is-visible');
  clearTimeout(w.barTimer);
  w.barTimer = setTimeout(() => r.bar.classList.remove('is-visible'), 3200);
}

/* ---------- 版本更新 ---------- */

function rebuildQueue(keepPosition = true) {
  const now = new Date();
  const nextQueue = buildQueue(w.photos, now);
  if (!nextQueue.length) return;
  const currentId = w.queue[w.index]?.id;
  w.queue = nextQueue;
  if (keepPosition && currentId) {
    const found = nextQueue.findIndex((photo) => photo.id === currentId);
    w.index = found >= 0 ? found : 0;
  } else {
    w.index = 0;
    show(0);
  }
}

function applyManifest(manifest) {
  const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
  const known = new Set(w.photos.map((photo) => photo.id));
  const fresh = photos.filter((photo) => !known.has(photo.id));
  w.photos = photos;
  if (!fresh.length) return;

  // 新内容插到当前位置之后，不打断正在放的这一张
  const insertAt = w.index + 1;
  w.queue.splice(insertAt, 0, ...fresh);
  w.hooks.onManifest?.(manifest, fresh);
}

/* ---------- 对外 ---------- */

export function enterWall(photos, options = {}) {
  const r = cache();
  w.active = true;
  w.photos = photos;
  w.playing = true;
  w.nightForced = null;
  w.hooks = options;
  w.interval = Number(options.interval) || 10;
  w.clock = options.clock !== false;
  if (options.night) w.nightWindow = options.night;
  w.dayKey = new Date().toDateString();
  w.queue = buildQueue(photos, new Date());

  r.interval.value = String(w.interval);
  r.clockToggle.classList.toggle('is-on', w.clock);
  r.clock.hidden = !w.clock;
  r.toggle.textContent = '暂停';
  r.root.hidden = false;
  r.root.classList.add('is-active');
  document.body.classList.add('wall-open');
  showBar();

  updateClock();
  w.clockTimer = setInterval(updateClock, 20000);
  show(0);

  acquireWake();
  w.watch = startVersionWatch({
    currentRev: options.rev || null,
    onUpdate: (manifest) => applyManifest(manifest),
    onState: (status) => r.root.classList.toggle('is-offline', status === 'offline'),
  });
}

export function exitWall() {
  if (!w.active) return;
  w.active = false;
  clearTimeout(w.timer);
  clearInterval(w.clockTimer);
  w.timer = null;
  w.clockTimer = null;
  releaseWake();
  w.watch?.stop();
  w.watch = null;

  const r = cache();
  r.root.hidden = true;
  r.root.classList.remove('is-active', 'is-night', 'is-offline');
  document.body.classList.remove('wall-open');
  for (const layer of r.stage.querySelectorAll('.wall-slide')) layer.remove();
  w.node = null;
  w.hooks.onClose?.();
}

export function isWallOpen() {
  return w.active;
}

export function initWall() {
  const r = cache();

  r.exit.addEventListener('click', exitWall);
  r.next.addEventListener('click', next);
  r.prev.addEventListener('click', prev);

  r.toggle.addEventListener('click', () => {
    w.playing = !w.playing;
    r.toggle.textContent = w.playing ? '暂停' : '播放';
    if (w.playing) {
      schedule(durationFor(w.queue[w.index]));
    } else {
      clearTimeout(w.timer);
      w.remaining = Math.max(0, w.dueAt - performance.now());
    }
  });

  r.interval.addEventListener('change', () => {
    w.interval = Number(r.interval.value) || 10;
    if (w.playing) schedule(durationFor(w.queue[w.index]));
  });

  r.clockToggle.addEventListener('click', () => {
    w.clock = !w.clock;
    r.clock.hidden = !w.clock;
    r.clockToggle.classList.toggle('is-on', w.clock);
  });

  r.night.addEventListener('click', () => {
    w.nightForced = !isNight();
    updateClock();
    showBar();
  });

  // 轻触唤出控制条；双击退出
  r.stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.wall-bar')) return;
    showBar();
  });
  r.stage.addEventListener('dblclick', exitWall);

  document.addEventListener('keydown', (event) => {
    if (!w.active) return;
    if (event.key === 'Escape') { event.preventDefault(); exitWall(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); next(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); prev(); }
    if (event.key === ' ') {
      event.preventDefault();
      w.playing = !w.playing;
      r.toggle.textContent = w.playing ? '暂停' : '播放';
      if (w.playing) schedule(durationFor(w.queue[w.index]));
      else clearTimeout(w.timer);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!w.active) return;
    if (document.visibilityState === 'hidden') {
      if (w.timer) {
        w.remaining = Math.max(0, w.dueAt - performance.now());
        clearTimeout(w.timer);
        w.timer = null;
      }
    } else {
      if (w.wantWake && !w.wake) acquireWake();
      if (w.playing && !w.timer) schedule(Math.max(w.remaining || 0, 1200));
      updateClock();
    }
  });
}
