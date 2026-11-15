import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HERO_KEY, HERO_CACHE, HERO_TIERS, pickHeroPhoto, publishHero,
} from '../processor/hero.mjs';

/**
 * 首屏静态图（V6 T-11）的纯逻辑与写路径断言。
 *
 * 写路径用一个内存桶代替 S3：这里要证明的是「选哪张、退到哪一档、失败了
 * 会不会把发布拖死」，不是 AWS SDK 能不能用。夹具全是占位 id 与假字节。
 *
 * Assertions for the static hero (V6 T-11). The write path runs against an
 * in-memory bucket: what matters here is which photo wins, which tier is used,
 * and that a failure never takes the publication down — not that the SDK works.
 */

const photo = (id, ratio = 1.5) => ({ id, ratio });

/** 内存桶：只实现 head / getBuffer / putBuffer 三个方法 */
function memoryBucket(objects = {}) {
  const store = new Map(Object.entries(objects).map(([key, size]) => [key, Buffer.alloc(size, 7)]));
  const puts = [];
  return {
    puts,
    store,
    async head(bucket, key) { return store.has(key) ? { size: store.get(key).length } : null; },
    async getBuffer(bucket, key) {
      if (!store.has(key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return store.get(key);
    },
    async putBuffer(bucket, key, body, options) {
      store.set(key, body);
      puts.push({ bucket, key, bytes: body.length, ...options });
    },
  };
}

/* ---------------- 选图 / Which photo leads ---------------- */

test('清单里的 hero 优先，哪怕它不是第一张', () => {
  const photos = [photo('newest'), photo('chosen', 1.6), photo('older')];
  assert.equal(pickHeroPhoto(photos, 'chosen').id, 'chosen');
});

test('hero 指向不存在的 id 时退回第一张横图', () => {
  const photos = [photo('portrait', 0.7), photo('landscape', 1.8), photo('also-landscape')];
  assert.equal(pickHeroPhoto(photos, 'ghost').id, 'landscape');
});

test('没有横图时取第一张——竖图也比空着好', () => {
  const photos = [photo('p1', 0.75), photo('p2', 0.8)];
  assert.equal(pickHeroPhoto(photos, '').id, 'p1');
});

test('ratio 缺失按 1 处理，不会误判成横图', () => {
  const photos = [{ id: 'no-ratio' }, photo('landscape', 1.4)];
  assert.equal(pickHeroPhoto(photos, '').id, 'landscape');
});

test('ratio 是数字字符串时照常当横图，非法值才按 1 处理', () => {
  // JSON 里 ratio 偶尔是字符串（手改过的清单），Number() 能救回来就别丢掉一张横图
  assert.equal(pickHeroPhoto([{ id: 'stringy', ratio: '1.6' }], '').id, 'stringy');
  const photos = [{ id: 'nan', ratio: 'x' }, photo('p', 1.3)];
  assert.equal(pickHeroPhoto(photos, '').id, 'p');
});

test('空清单与脏条目都不炸', () => {
  assert.equal(pickHeroPhoto([], 'x'), null);
  assert.equal(pickHeroPhoto(null), null);
  assert.equal(pickHeroPhoto([null, { id: '' }, { ratio: 2 }], 'x'), null);
});

/* ---------------- 写路径 / The write path ---------------- */

test('优先拷 view（2048w），固定名与缓存头都对', async () => {
  const io = memoryBucket({ 'photos/p1/view.webp': 4096, 'photos/p1/grid.webp': 800 });
  const result = await publishHero('site', { photos: [photo('p1')], hero: '' }, { io });
  assert.equal(result.written, true);
  assert.equal(result.photo, 'p1');
  assert.equal(result.source, 'photos/p1/view.webp');
  assert.equal(result.bytes, 4096);
  assert.equal(io.puts.length, 1);
  assert.equal(io.puts[0].key, HERO_KEY);
  assert.equal(io.puts[0].contentType, 'image/webp');
  assert.equal(io.puts[0].cacheControl, HERO_CACHE);
});

test('view 缺失时按 HERO_TIERS 顺序往下退', async () => {
  const io = memoryBucket({ 'photos/p1/thumb.webp': 320, 'photos/p1/poster.webp': 900 });
  const result = await publishHero('site', { photos: [photo('p1')] }, { io });
  assert.equal(result.written, true);
  assert.equal(result.source, 'photos/p1/thumb.webp');
  assert.equal(io.puts.length, 1);
  // 退回顺序来自常量本身：改顺序就是改行为，这里把它钉住
  assert.deepEqual(HERO_TIERS, ['view.webp', 'grid.webp', 'thumb.webp', 'poster.webp']);
});

test('一档都没有时返回 no-derivative，且没有写过任何对象', async () => {
  const io = memoryBucket({});
  const result = await publishHero('site', { photos: [photo('p1')] }, { io });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'no-derivative');
  assert.equal(io.puts.length, 0);
});

test('空清单返回 no-photo，不访问存储', async () => {
  const io = memoryBucket({});
  let touched = 0;
  io.head = async () => { touched += 1; return null; };
  const result = await publishHero('site', { photos: [] }, { io });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'no-photo');
  assert.equal(touched, 0);
});

test('某一档读失败会继续试下一档，而不是整次放弃', async () => {
  const io = memoryBucket({ 'photos/p1/view.webp': 100, 'photos/p1/grid.webp': 200 });
  let first = true;
  const realGet = io.getBuffer.bind(io);
  io.getBuffer = async (bucket, key) => {
    if (first) { first = false; throw Object.assign(new Error('boom'), { name: 'SlowDown' }); }
    return realGet(bucket, key);
  };
  const result = await publishHero('site', { photos: [photo('p1')] }, { io });
  assert.equal(result.written, true);
  assert.equal(result.source, 'photos/p1/grid.webp');
});

test('全链路失败也不抛错——首屏是装饰，不能拖死发布', async () => {
  const io = memoryBucket({});
  io.head = async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); };
  const result = await publishHero('site', { photos: [photo('p1')] }, { io });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'error');
  assert.equal(result.photo, 'p1');
});

test('空 buffer 当作这一档没有，继续往下退', async () => {
  const io = memoryBucket({ 'photos/p1/view.webp': 0, 'photos/p1/grid.webp': 64 });
  const result = await publishHero('site', { photos: [photo('p1')] }, { io });
  assert.equal(result.written, true);
  assert.equal(result.source, 'photos/p1/grid.webp');
});
