import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_SAFETY_MS, PORTRAIT_HOLD_MS, MIN_PHOTO_MS,
  parseSource, sourceToken, sourceOptions, sourcePool,
  dedupeBurst, buildQueue, dwellMs, isMotion, portraitIds,
} from '../js/wall-source.js';

/**
 * V6 T-25 照片墙 2.0。
 *
 * 四个判据在这里是可执行的：
 *   1. 四源切换队列正确 —— `sourcePool` 是唯一的池子，互斥由它保证；
 *   2. 视频不被中途切断 —— 视频的 `dwellMs` 必须是 0（= 不排等时器）；
 *   3. 一轮内近似照片只出现一次 —— `dedupeBurst`；
 *   4. 精选为空回退全部并给理由 —— `fallback: true` + `reason`。
 *
 * Four executable criteria: mutually exclusive pools, videos never get a dwell
 * timer, burst near-duplicates collapse once per round, and an empty picks
 * source falls back to "all" with a reason the UI can speak.
 */

/** lqip 的假指纹：长度要过门槛，内容只需可区分 */
const lqip = (tag) => `data:image/webp;base64,${tag.padEnd(40, 'A')}`;

const photos = [
  { id: 'a', type: 'image', year: 2026, month: 11, album: '海边', lqip: lqip('a') },
  { id: 'b', type: 'image', year: 2026, month: 11, album: '海边', lqip: lqip('b') },
  { id: 'c', type: 'video', year: 2026, month: 11, album: '海边', src: 'photos/c/clip.mp4', lqip: lqip('c'), duration: 30 },
  { id: 'd', type: 'image', year: 2025, month: 11, album: '山里', lqip: lqip('d') },
  { id: 'e', type: 'image', year: 2024, month: 3, album: '山里', lqip: lqip('e') },
];

test('播放源：解析与回写是一对', () => {
  assert.deepEqual(parseSource('all'), { kind: 'all', value: '' });
  assert.deepEqual(parseSource('picks'), { kind: 'picks', value: '' });
  assert.deepEqual(parseSource('year:2026'), { kind: 'year', value: '2026' });
  assert.deepEqual(parseSource('album:海边'), { kind: 'album', value: '海边' });
  for (const token of ['all', 'picks', 'year:2026', 'album:海边']) {
    assert.equal(sourceToken(parseSource(token)), token);
  }
});

test('播放源：认不出的 token 退回全部，不抛错', () => {
  for (const token of ['', null, undefined, 'year:abc', 'year:1200', 'album:', 'wat']) {
    assert.equal(sourceToken(parseSource(token)), 'all', `${token} 应当退回 all`);
  }
});

test('四源互斥：每个源只出自己的照片', () => {
  assert.deepEqual(sourcePool(photos, { kind: 'year', value: '2026' }).photos.map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(sourcePool(photos, { kind: 'album', value: '山里' }).photos.map((p) => p.id), ['d', 'e']);
  assert.deepEqual(sourcePool(photos, { kind: 'all', value: '' }).photos.map((p) => p.id), ['a', 'b', 'c', 'd', 'e']);
  const picked = sourcePool(photos, { kind: 'picks', value: '' }, { picks: ['c', 'e'] });
  assert.deepEqual(picked.photos.map((p) => p.id), ['c', 'e']);
  assert.equal(picked.fallback, false);
});

test('精选为空：回退全部并给出理由', () => {
  const empty = sourcePool(photos, { kind: 'picks', value: '' }, { picks: [] });
  assert.equal(empty.fallback, true);
  assert.equal(empty.reason, 'picks-empty');
  assert.equal(empty.photos.length, photos.length);
  assert.deepEqual(empty.source, { kind: 'all', value: '' }, '回退要连 source 一起改，否则下拉框还显示精选');

  // 策展产物里的 id 全失效（照片被删）也不能播空白
  const stale = sourcePool(photos, { kind: 'picks', value: '' }, { picks: ['gone', 'also-gone'] });
  assert.equal(stale.fallback, true);
  assert.equal(stale.reason, 'picks-stale');
  assert.equal(stale.photos.length, photos.length);
});

test('空年份 / 空相册也回退全部并给理由', () => {
  const year = sourcePool(photos, { kind: 'year', value: '2019' });
  assert.equal(year.reason, 'year-empty');
  const album = sourcePool(photos, { kind: 'album', value: '不存在的相册' });
  assert.equal(album.reason, 'album-empty');
});

test('源选项：全部 + 精选 + 每年 + 每相册', () => {
  const options = sourceOptions(photos);
  assert.deepEqual(options.map((item) => item.token), [
    'all', 'picks', 'year:2026', 'year:2025', 'year:2024', 'album:海边', 'album:山里',
  ]);
  assert.equal(options[0].count, 5);
  assert.equal(options.find((item) => item.token === 'year:2026').label, '2026 年');
  assert.equal(options.find((item) => item.token === 'album:海边').label, '海边');
});

test('源选项：相册按条目数降序，同年数按码位', () => {
  const options = sourceOptions([
    { id: '1', year: 2026, album: 'B' },
    { id: '2', year: 2026, album: 'A' },
    { id: '3', year: 2026, album: 'A' },
  ]);
  const albums = options.filter((item) => item.token.startsWith('album:')).map((item) => item.token);
  assert.deepEqual(albums, ['album:A', 'album:B']);
});

test('连拍近似：同一轮里相同 lqip 只留第一张', () => {
  const same = [
    { id: 'x1', year: 2026, month: 5, lqip: lqip('same') },
    { id: 'y', year: 2026, month: 5, lqip: lqip('other') },
    { id: 'x2', year: 2026, month: 5, lqip: lqip('same') },
  ];
  assert.deepEqual(dedupeBurst(same).map((p) => p.id), ['x1', 'y']);
});

test('连拍近似：没有 lqip 就不合并——不猜', () => {
  const noLqip = [
    { id: 'p1', year: 2026, month: 5 },
    { id: 'p2', year: 2026, month: 5 },
    { id: 'p3', year: 2026, month: 5, lqip: '' },
  ];
  assert.equal(dedupeBurst(noLqip).length, 3);
});

test('连拍近似：不同月份相同 lqip 不算同一张（纯色卡之类的撞指纹）', () => {
  const crossMonth = [
    { id: 'm1', year: 2026, month: 5, lqip: lqip('flat') },
    { id: 'm2', year: 2026, month: 9, lqip: lqip('flat') },
  ];
  assert.equal(dedupeBurst(crossMonth).length, 2);
});

test('队列：一轮内不重复，连拍只出现一次', () => {
  const dup = [...photos, { ...photos[0], id: 'a-dup' }];
  const queue = buildQueue(dup, { now: new Date('2026-11-20T10:00:00Z'), shuffle: (list) => list });
  const ids = queue.map((photo) => photo.id);
  assert.equal(new Set(ids).size, ids.length, '不能有重复');
  assert.ok(!ids.includes('a-dup'), '相同 lqip 的第二张不该进队列');
});

test('队列：往年同月排最前面', () => {
  const queue = buildQueue(photos, { now: new Date('2026-11-20T10:00:00Z'), shuffle: (list) => list });
  // 2025-11 是「往年同月」，要排在最近的那些之前
  assert.equal(queue[0].id, 'd');
});

test('队列：空池子给空队列，不抛错', () => {
  assert.deepEqual(buildQueue([], { now: new Date() }), []);
  assert.deepEqual(buildQueue(null, { now: new Date() }), []);
});

test('停留时长：视频是 0，意思是不排等时器', () => {
  const video = { id: 'c', type: 'video', src: 'x.mp4', duration: 30 };
  assert.equal(dwellMs(video, { interval: 5 }), 0);
  assert.equal(dwellMs(video, { interval: 30 }), 0);
  assert.ok(VIDEO_SAFETY_MS >= 30000, '安全上限至少要比最长的片长（30 秒）长');
});

test('停留时长：静图按间隔，人像多停 1.5 秒', () => {
  const image = { id: 'a', type: 'image' };
  assert.equal(dwellMs(image, { interval: 10 }), 10000);
  assert.equal(dwellMs(image, { interval: 10, portrait: true }), 10000 + PORTRAIT_HOLD_MS);
  assert.ok(PORTRAIT_HOLD_MS >= 1000 && PORTRAIT_HOLD_MS <= 2000, '人像多停 1–2 秒');
});

test('停留时长：间隔再小也有下限，别把照片刷成幻灯片', () => {
  assert.equal(dwellMs({ type: 'image' }, { interval: 1 }), MIN_PHOTO_MS);
  assert.equal(dwellMs({ type: 'image' }, {}), 10000, '缺省 10 秒');
});

test('isMotion：视频 / 实况 / 动图，且必须有 src', () => {
  assert.equal(isMotion({ type: 'video', src: 'a.mp4' }), true);
  assert.equal(isMotion({ type: 'video' }), false, '没有 src 的条目会渲染成静图，不能当视频等 ended');
  assert.equal(isMotion({ type: 'image' }), false);
  assert.equal(isMotion(null), false);
});

test('人像集合：person / people 标签都算，索引缺失时是空集合', () => {
  const ids = portraitIds([
    { id: 'a', labels: [{ term: 'person', kind: 'object' }] },
    { id: 'b', labels: [{ term: 'people', kind: 'object' }] },
    { id: 'c', labels: [{ term: 'car', kind: 'object' }] },
  ]);
  assert.deepEqual([...ids], ['a', 'b']);
  assert.equal(portraitIds(undefined).size, 0);
});
