import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyManifest, normalizeManifest, upsertPhoto, buildAlbums, countTypes,
} from '../processor/manifest.mjs';

const photo = (id, year, month, type = 'image') => ({
  id,
  type,
  album: String(year),
  year,
  month,
  tags: [String(year)],
  ratio: 1,
  lqip: '',
  featured: false,
});

test('空清单补齐前端需要的顶层字段', () => {
  const manifest = emptyManifest();
  for (const key of ['site', 'wall', 'story', 'hero', 'photos', 'albums']) {
    assert.ok(key in manifest, `缺少 ${key}`);
  }
  assert.deepEqual(manifest.photos, []);
});

test('normalizeManifest 填缺省值但不覆盖已有配置', () => {
  const normalized = normalizeManifest({ site: { title: '我的相册', subtitle: 's' } });
  assert.equal(normalized.site.title, '我的相册');
  assert.equal(normalized.site.subtitle, 's');
  assert.equal(normalized.wall.interval, 10);
  assert.deepEqual(normalized.photos, []);
});

test('normalizeManifest 对垃圾输入退回空清单', () => {
  assert.deepEqual(normalizeManifest(null).photos, []);
  assert.deepEqual(normalizeManifest([]).photos, []);
  assert.deepEqual(normalizeManifest('x').photos, []);
});

test('upsert 新增按时间倒序，重复 id 覆盖而不是追加', () => {
  let manifest = emptyManifest();
  manifest = upsertPhoto(manifest, photo('aaa', 2025, 3));
  manifest = upsertPhoto(manifest, photo('bbb', 2026, 11));
  manifest = upsertPhoto(manifest, photo('ccc', 2026, 11));

  assert.deepEqual(manifest.photos.map((p) => p.id), ['bbb', 'ccc', 'aaa']);

  // 同一张图重传：条目数不变，内容被更新
  const updated = { ...photo('aaa', 2025, 3), caption: '重传' };
  manifest = upsertPhoto(manifest, updated);
  assert.equal(manifest.photos.length, 3);
  assert.equal(manifest.photos.find((p) => p.id === 'aaa').caption, '重传');
});

test('同月内按 id 稳定排序，保证清单哈希可复现', () => {
  const a = upsertPhoto(emptyManifest(), photo('zzz', 2026, 5));
  const b = upsertPhoto(emptyManifest(), photo('aaa', 2026, 5));
  const forward = upsertPhoto(a, photo('aaa', 2026, 5));
  const backward = upsertPhoto(b, photo('zzz', 2026, 5));
  assert.deepEqual(
    forward.photos.map((p) => p.id),
    backward.photos.map((p) => p.id),
  );
});

test('相册封面取该相册最新一条，计数正确', () => {
  const albums = buildAlbums([
    photo('bbb', 2026, 11),
    photo('aaa', 2026, 3),
    photo('ccc', 2025, 7),
  ]);
  assert.deepEqual(albums, [
    { name: '2026', count: 2, cover: 'bbb', coverType: 'image' },
    { name: '2025', count: 1, cover: 'ccc', coverType: 'image' },
  ]);
});

test('countTypes 把视频单列', () => {
  assert.deepEqual(countTypes([photo('a', 2026, 1), photo('b', 2026, 1, 'video')]), {
    photos: 1,
    videos: 1,
  });
});

test('upsert 保留站点配置，不会被处理函数冲掉', () => {
  const base = normalizeManifest({
    site: { title: '陈馨的相册', subtitle: '2019 起' },
    wall: { interval: 20, clock: false, night: { from: '21:00', to: '06:00' } },
    hero: 'keep-me',
  });
  const next = upsertPhoto(base, photo('aaa', 2026, 1));
  assert.equal(next.site.title, '陈馨的相册');
  assert.equal(next.wall.interval, 20);
  assert.equal(next.hero, 'keep-me');
});
