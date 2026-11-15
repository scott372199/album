/* eslint-disable no-restricted-globals */
/**
 * 离线可读（V6 T-28）。**这不是 PWA**：没有 Web App Manifest，没有安装引导，
 * 也没有推送——只做一件事：把「已经访问过的照片」和「最近三个月」的缩略图留在
 * 本机，断网时还能翻。
 *
 * 三条边界：
 *
 * 1. **只缓存 `thumb.webp`**。`grid` / `view` / 整段视频都不进缓存：一张 view
 *    是 200–400 KB，视频 20 MB，缓存它们等于拿用户的存储做赌注。断网时点开灯箱
 *    会拿到不到大图，灯箱自己会降级到缩略图并说明情况。
 * 2. **上限 80 MB，最近优先淘汰**。超过上限就从最老插入的那条开始删，删到 85%
 *    为止——留一点余量，避免每加一张就触发一轮淘汰。
 * 3. **缓存名带 rev**。内容一换（`data/version.json` 的 rev 变了），旧缓存整套
 *    作废、`activate` 里清掉。已删除的照片因此不可能在清单里复活，也不会被
 *    当成「离线还能打开」。
 *
 * Not a PWA: no web app manifest, no install prompt, no push. Only thumbnails
 * of recently visited and recent-three-month photos are cached (80 MB cap,
 * oldest-first eviction), cache names carry the content rev, and activate purges
 * everything from another rev so deleted photos cannot come back.
 */

const SW_VERSION = 1;
const MAX_BYTES = 80 * 1024 * 1024;
const EVICT_TARGET = Math.floor(MAX_BYTES * 0.85);
const RECENT_MONTHS = 3;
const VERSION_PATH = '/data/version.json';
const THUMB_RE = /^\/photos\/[^/]+\/thumb\.webp$/;

/** 当前内容 rev。空串表示还不知道（首次安装、还没拿到 version.json） */
let rev = '';

/** 每条缓存的大小账本：key -> bytes。SW 重启后靠 `measure()` 重建 */
const ledger = new Map();

function cacheName(kind) {
  return `album-v${SW_VERSION}-${rev || 'unknown'}-${kind}`;
}

/**
 * 纯函数：这条请求该怎么办。
 *
 * 返回 `nav` / `version` / `data` / `thumb` / `asset` / `bypass`。
 * 只有 GET、同源、且属于站点自身的请求才会被接管；跨域（预签名上传的 S3）
 * 一律放过——那不是我们该缓存的东西，接了还会把上传搞坏。
 */
function strategyFor({ url, method = 'GET', navigation = false, selfOrigin = '' } = {}) {
  if (method !== 'GET') return 'bypass';
  if (!url) return 'bypass';
  if (selfOrigin && url.origin !== selfOrigin) return 'bypass';
  const pathname = url.pathname || '/';
  if (navigation) return 'nav';
  if (pathname === VERSION_PATH) return 'version';
  if (pathname.startsWith('/data/')) return 'data';
  if (THUMB_RE.test(pathname)) return 'thumb';
  if (pathname.startsWith('/photos/')) return 'bypass';
  if (pathname.startsWith('/assets/') || pathname === '/' || pathname === '/index.html') return 'asset';
  return 'bypass';
}

/**
 * 「近三个月」的月份键集合：本月 + 前两个月。
 * 用字符串键比较，避免每个调用点重复算年月。
 */
function recentMonthKeys(now = new Date()) {
  const keys = new Set();
  for (let back = 0; back < RECENT_MONTHS; back += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    keys.add(`${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`);
  }
  return keys;
}

/** 清单里「近三个月」的缩略图地址；其它一概不预热 */
function recentThumbs(manifest, now = new Date()) {
  const keys = recentMonthKeys(now);
  const out = [];
  for (const photo of Array.isArray(manifest?.photos) ? manifest.photos : []) {
    if (!photo || !photo.thumb) continue;
    if (!keys.has(`${photo.year}-${photo.month}`)) continue;
    out.push(`/${String(photo.thumb).replace(/^\/+/, '')}`);
  }
  return out;
}

/**
 * 淘汰：从最老插入的删起，删到目标以下。
 * 插入顺序就是 Cache API `keys()` 的顺序，所以「最近优先」不需要额外记账。
 */
async function evict(cache, { maxBytes = MAX_BYTES, target = EVICT_TARGET } = {}) {
  let total = 0;
  for (const bytes of ledger.values()) total += bytes;
  if (total <= maxBytes) return { removed: 0, total };
  const keys = await cache.keys();
  let removed = 0;
  for (const request of keys) {
    if (total <= target) break;
    const bytes = ledger.get(request.url) || 0;
    await cache.delete(request);
    ledger.delete(request.url);
    total -= bytes;
    removed += 1;
  }
  return { removed, total };
}

/** 存一条；顺手记账与淘汰 */
async function remember(cacheNameValue, request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(cacheNameValue);
  const copy = response.clone();
  // 记账要真实字节数：Content-Length 有时缺失（分块响应），所以取 blob 的 size
  let bytes = Number(response.headers.get('content-length')) || 0;
  if (!bytes) {
    try { bytes = (await copy.clone().blob()).size; } catch { bytes = 0; }
  }
  await cache.put(request, copy);
  ledger.set(typeof request === 'string' ? request : request.url, bytes);
  await evict(cache);
}

async function fromCache(name, request) {
  const cache = await caches.open(name);
  return cache.match(request, { ignoreSearch: true });
}

/** 网络优先：拿到就更新缓存，拿不到回缓存。离线时清单/索引/入口页都靠它 */
async function networkFirst(name, request, event) {
  try {
    const response = await fetch(request);
    if (response && response.ok) event.waitUntil(remember(name, request, response.clone()));
    return response;
  } catch (err) {
    const hit = await fromCache(name, request);
    if (hit) return hit;
    throw err;
  }
}

/** 缓存优先：文件名带内容哈希的产物、以及缩略图都属于这一类 */
async function cacheFirst(name, request, event) {
  const hit = await fromCache(name, request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.ok) event.waitUntil(remember(name, request, response.clone()));
  return response;
}

/**
 * 学习当前 rev：`version.json` 是唯一的真相来源。rev 变了就清掉别的缓存，
 * 这样「已删除的照片不再出现」不需要任何额外逻辑——旧清单本身没了。
 */
async function learnRev(response) {
  try {
    const data = await response.clone().json();
    const next = String(data?.rev || '');
    if (!next) return;
    if (next === rev) return;
    rev = next;
    await purgeOtherRevs();
  } catch { /* 不是 JSON 就当作没学到，下一次再试 */ }
}

async function purgeOtherRevs() {
  const names = await caches.keys();
  const keep = `album-v${SW_VERSION}-${rev}-`;
  await Promise.all(names
    .filter((name) => name.startsWith('album-v') && !name.startsWith(keep))
    .map((name) => caches.delete(name)));
}

/**
 * 预热：把近三个月的缩略图先拉一遍。
 * 失败一条不影响其它条——离线能力是加分项，不能反过来把安装搞挂。
 */
async function warmRecentThumbs() {
  let manifestUrl = '/data/manifest.json';
  try {
    const version = await fetch(`${VERSION_PATH}?_=${Date.now()}`, { cache: 'no-store' });
    if (version.ok) {
      const data = await version.clone().json();
      if (data?.rev) rev = String(data.rev);
      if (data?.manifest) manifestUrl = `/${String(data.manifest).replace(/^\/+/, '')}`;
    }
  } catch { return; }

  let manifest;
  try {
    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!response.ok) return;
    await remember(cacheName('data'), manifestUrl, response.clone());
    manifest = await response.json();
  } catch { return; }

  const cache = await caches.open(cacheName('thumb'));
  for (const path of recentThumbs(manifest)) {
    try {
      if (await cache.match(path)) continue;
      const response = await fetch(path, { cache: 'force-cache' });
      if (response.ok) await remember(cacheName('thumb'), path, response);
    } catch { /* 单张失败忽略 */ }
  }
}

self.addEventListener('install', (event) => {
  // 立刻接管：离线能力要在第一次访问之后就成立，不该等下次打开
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(cacheName('shell'));
      await cache.addAll(['/index.html']);
    } catch { /* 入口页取不到就等运行时再补 */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await purgeOtherRevs();
    await warmRecentThumbs();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const kind = strategyFor({
    url,
    method: request.method,
    navigation: request.mode === 'navigate',
    selfOrigin: self.location.origin,
  });
  if (kind === 'bypass') return;

  if (kind === 'nav') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) event.waitUntil(remember(cacheName('shell'), '/index.html', response.clone()));
        return response;
      } catch {
        const hit = await fromCache(cacheName('shell'), '/index.html');
        if (hit) return hit;
        throw new Error('offline');
      }
    })());
    return;
  }

  if (kind === 'version') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          event.waitUntil((async () => {
            await remember(cacheName('data'), request, response.clone());
            await learnRev(response.clone());
          })());
        }
        return response;
      } catch {
        const hit = await fromCache(cacheName('data'), request);
        if (hit) return hit;
        throw new Error('offline');
      }
    })());
    return;
  }

  if (kind === 'data' || kind === 'asset') {
    event.respondWith(networkFirst(cacheName(kind === 'data' ? 'data' : 'shell'), request, event));
    return;
  }

  if (kind === 'thumb') {
    event.respondWith(cacheFirst(cacheName('thumb'), request, event));
  }
});

/**
 * 测试钩子：Node 里用一个假 `self` / `caches` 加载本文件，然后直接调这些纯函数。
 * 线上不依赖它——把内部函数挂出来只为让「缓存策略」这件事可以被断言，而不是
 * 靠手点。
 */
self.__albumSw = {
  SW_VERSION, MAX_BYTES, RECENT_MONTHS, VERSION_PATH,
  strategyFor, recentMonthKeys, recentThumbs, evict,
  getRev: () => rev,
  setRev: (value) => { rev = String(value || ''); },
  cacheName,
  ledger,
};
