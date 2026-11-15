import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * V6 T-28 离线可读。
 *
 * 这个文件**直接加载要上线的那份 `sw.js`**（用 vm 给一个假 `self` / `caches`），
 * 断言的是真代码而不是它的影子。理由：Service Worker 的坑几乎全在「哪条请求该
 * 走哪条策略」上，写一份镜像实现来测只会测到镜像。
 *
 * 判据对应的断言：
 *   - 只缓存 manifest + 近三个月 thumb → `strategyFor` / `recentThumbs`
 *   - 上限 80 MB，最近优先淘汰 → `evict`
 *   - 缓存名带 rev，换 rev 清旧 → `cacheName` / `setRev`
 *   - 未注册 SW 的浏览器行为不变 → 页面侧只在 https 下注册（见 main.js），
 *     本文件同时断言 SW 不碰跨域请求（预签名上传不会被拦）
 *
 * The shipped `sw.js` is loaded as-is inside a sandbox: the risky part of a
 * service worker is which request takes which strategy, and testing a mirror
 * implementation would only test the mirror.
 */

const SOURCE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

/** 够用的 Cache Storage 假实现：按插入顺序返回 keys，正好对上「最近优先淘汰」 */
function fakeCaches() {
  const store = new Map();
  const stats = { open: 0, put: 0, deleted: [] };
  const cacheFor = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const map = store.get(name);
    return {
      async put(request, response) {
        stats.put += 1;
        map.set(typeof request === 'string' ? request : request.url, response);
      },
      async match(request) {
        const key = typeof request === 'string' ? request : request.url;
        return map.get(key) || undefined;
      },
      async keys() {
        return [...map.keys()].map((url) => ({ url }));
      },
      async delete(request) {
        const key = typeof request === 'string' ? request : request.url;
        return map.delete(key);
      },
      async addAll() { /* 安装期预热不在本测试范围内 */ },
    };
  };
  return {
    stats,
    store,
    async open(name) { stats.open += 1; return cacheFor(name); },
    async keys() { return [...store.keys()]; },
    async delete(name) {
      stats.deleted.push(name);
      return store.delete(name);
    },
  };
}

function loadSw({ caches = fakeCaches(), fetchImpl = () => Promise.reject(new Error('offline')) } = {}) {
  const listeners = {};
  const sandbox = {
    URL,
    Date,
    Map,
    Set,
    Math,
    Number,
    String,
    JSON,
    Promise,
    Response: class {},
    console,
    fetch: fetchImpl,
    caches,
    self: {
      location: { origin: 'https://album.example' },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SOURCE, sandbox, { filename: 'sw.js' });
  return { api: sandbox.self.__albumSw, listeners, caches };
}

const url = (path) => new URL(path, 'https://album.example');

test('策略：导航请求走网络优先，离线回入口页', () => {
  const { api } = loadSw();
  assert.equal(api.strategyFor({ url: url('/'), navigation: true, selfOrigin: 'https://album.example' }), 'nav');
  assert.equal(api.strategyFor({ url: url('/some/deep/link'), navigation: true, selfOrigin: 'https://album.example' }), 'nav');
});

test('策略：只有 thumb 进离线缓存', () => {
  const { api } = loadSw();
  const origin = 'https://album.example';
  assert.equal(api.strategyFor({ url: url('/photos/abc/thumb.webp'), selfOrigin: origin }), 'thumb');
  // 大图与视频一律放过：缓存它们等于拿用户存储做赌注
  for (const path of ['/photos/abc/grid.webp', '/photos/abc/view.webp', '/photos/abc/poster.webp', '/photos/abc/clip.mp4']) {
    assert.equal(api.strategyFor({ url: url(path), selfOrigin: origin }), 'bypass', `${path} 不该被缓存`);
  }
});

test('策略：清单与语义索引网络优先，离线回缓存', () => {
  const { api } = loadSw();
  const origin = 'https://album.example';
  assert.equal(api.strategyFor({ url: url('/data/version.json'), selfOrigin: origin }), 'version');
  assert.equal(api.strategyFor({ url: url('/data/manifest.a75ad99f29dd.json'), selfOrigin: origin }), 'data');
  assert.equal(api.strategyFor({ url: url('/data/search-index.json'), selfOrigin: origin }), 'data');
});

test('策略：带哈希的产物走缓存优先', () => {
  const { api } = loadSw();
  const origin = 'https://album.example';
  assert.equal(api.strategyFor({ url: url('/assets/js.7d211c34/main.js'), selfOrigin: origin }), 'asset');
  assert.equal(api.strategyFor({ url: url('/index.html'), selfOrigin: origin }), 'asset');
});

test('策略：跨域与非 GET 一律放过——预签名上传不能被拦', () => {
  const { api } = loadSw();
  assert.equal(
    api.strategyFor({ url: url('https://s3.amazonaws.com/bucket/key'), selfOrigin: 'https://album.example' }),
    'bypass',
  );
  assert.equal(
    api.strategyFor({ url: url('/photos/abc/thumb.webp'), method: 'PUT', selfOrigin: 'https://album.example' }),
    'bypass',
  );
  assert.equal(api.strategyFor({}), 'bypass', '没有 url 时也不能抛错');
});

test('近三个月：本月 + 前两个月，跨年也对', () => {
  const { api } = loadSw();
  const keys = [...api.recentMonthKeys(new Date('2026-01-15T10:00:00Z'))].sort();
  assert.deepEqual(keys, ['2025-11', '2025-12', '2026-1']);
  assert.equal(api.RECENT_MONTHS, 3);
});

test('预热清单：只挑近三个月的缩略图', () => {
  const { api } = loadSw();
  const manifest = {
    photos: [
      { id: 'a', year: 2026, month: 11, thumb: 'photos/a/thumb.webp' },
      { id: 'b', year: 2026, month: 10, thumb: 'photos/b/thumb.webp' },
      { id: 'c', year: 2026, month: 9, thumb: 'photos/c/thumb.webp' },
      { id: 'd', year: 2026, month: 3, thumb: 'photos/d/thumb.webp' },
      { id: 'e', year: 2026, month: 11, poster: 'photos/e/poster.webp' },
    ],
  };
  // 展开一层：vm 沙箱里造出来的数组原型不是本 realm 的，deepStrictEqual 会挑刺
  const thumbs = [...api.recentThumbs(manifest, new Date('2026-11-20T10:00:00Z'))];
  assert.deepEqual(thumbs.sort(), ['/photos/a/thumb.webp', '/photos/b/thumb.webp', '/photos/c/thumb.webp']);
  assert.ok(thumbs.every((path) => !path.includes('//')), '路径不能出现双斜杠');
});

test('上限：超 80 MB 从最老插入的删起，删到 85% 为止', async () => {
  const caches = fakeCaches();
  const { api } = loadSw({ caches });
  const cache = await caches.open('album-v1-r1-thumb');
  const size = 10 * 1024 * 1024;
  for (let i = 0; i < 9; i += 1) {
    const key = `/photos/p${i}/thumb.webp`;
    await cache.put(key, { ok: true });
    api.ledger.set(key, size);
  }
  assert.equal(api.MAX_BYTES, 80 * 1024 * 1024);

  const result = await api.evict(cache, { maxBytes: 85 * 1024 * 1024, target: 80 * 1024 * 1024 });
  // 90 MB 超了，删掉最老的 1 条就回到 80 MB
  assert.equal(result.removed, 1);
  assert.equal(result.total, 80 * 1024 * 1024);
  const left = (await cache.keys()).map((request) => request.url);
  assert.ok(!left.includes('/photos/p0/thumb.webp'), '最老的那条应当被删');
  assert.ok(left.includes('/photos/p8/thumb.webp'), '最新的那条必须留着');
});

test('上限：没超就一条都不删', async () => {
  const caches = fakeCaches();
  const { api } = loadSw({ caches });
  const cache = await caches.open('album-v1-r1-thumb');
  await cache.put('/photos/x/thumb.webp', { ok: true });
  api.ledger.set('/photos/x/thumb.webp', 1024);
  const result = await api.evict(cache, { maxBytes: 80 * 1024 * 1024 });
  assert.equal(result.removed, 0);
});

test('缓存名带 rev：rev 一变就是另一套缓存', () => {
  const { api } = loadSw();
  api.setRev('a75ad99f29dd');
  const before = api.cacheName('thumb');
  assert.match(before, /a75ad99f29dd/);
  api.setRev('b00000000000');
  assert.notEqual(api.cacheName('thumb'), before);
  api.setRev('');
  assert.match(api.cacheName('data'), /unknown/, '还没拿到 rev 时也不能撞名');
});

test('不是 PWA：没有 manifest 链接、没有安装引导、没有推送', () => {
  for (const banned of ['beforeinstallprompt', 'showNotification', 'PushManager', 'rel="manifest"', 'manifest.json"']) {
    assert.ok(!SOURCE.includes(banned), `离线能力不该顺手变成 PWA：${banned}`);
  }
});

test('注册只在 https 下发生（未注册 SW 的浏览器行为不变）', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /serviceWorker\.register\(/);
  assert.match(main, /location\.protocol !== 'https:'/, '非 https 必须直接返回');
});
