import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeKey, decodeAlbum, kindOf, resolveYearMonth, tagsFor, sha256,
} from '../processor/derive.mjs';

test('decodeKey 解开中文相册名的 URL 编码', () => {
  assert.equal(decodeKey('incoming/%E5%AE%B6%E4%BA%BA/ab12.jpg'), 'incoming/家人/ab12.jpg');
  assert.equal(decodeKey('incoming/a+b.jpg'), 'incoming/a b.jpg');
  assert.equal(decodeKey(''), '');
  // 非法编码不能抛，否则一条坏记录会挡住整批
  assert.equal(decodeKey('incoming/%ZZ.jpg'), 'incoming/%ZZ.jpg');
});

test('decodeAlbum 走 base64url，缺省是未分类', () => {
  const encoded = Buffer.from('2026 旅行', 'utf8').toString('base64url');
  assert.equal(decodeAlbum(encoded), '2026 旅行');
  assert.equal(decodeAlbum(''), '未分类');
  assert.equal(decodeAlbum(undefined), '未分类');
});

test('kindOf 先看 content-type，再退回扩展名', () => {
  assert.equal(kindOf('image/jpeg', 'incoming/x.jpg'), 'image');
  assert.equal(kindOf('video/quicktime', 'incoming/x.mov'), 'video');
  assert.equal(kindOf('', 'incoming/x.heic'), 'image');
  assert.equal(kindOf('application/octet-stream', 'incoming/x.mp4'), 'video');
  assert.equal(kindOf('application/pdf', 'incoming/x.pdf'), null);
  assert.equal(kindOf('', 'incoming/noext'), null);
});

test('resolveYearMonth：客户端绝对时刻换算到 UTC+8', () => {
  // UTC 10 月 31 日 23:30 = 北京时间 11 月 1 日 07:30
  const result = resolveYearMonth({ takenAt: new Date('2026-10-31T23:30:00Z') });
  assert.deepEqual(result, { year: 2026, month: 11 });
});

test('resolveYearMonth：EXIF 墙上时间不再换算', () => {
  // exifr 把没有时区的 DateTimeOriginal 直接当 UTC，再 +8 就会跨月
  const result = resolveYearMonth({ exifShotAt: new Date('2026-11-01T07:00:00Z') });
  assert.deepEqual(result, { year: 2026, month: 11 });
});

test('resolveYearMonth：优先客户端，其次 EXIF，最后 LastModified', () => {
  const takenAt = new Date('2026-01-01T00:00:00Z');
  const exifShotAt = new Date('2025-06-01T00:00:00Z');
  const lastModified = new Date('2024-03-01T00:00:00Z');

  assert.deepEqual(resolveYearMonth({ takenAt, exifShotAt, lastModified }), { year: 2026, month: 1 });
  assert.deepEqual(resolveYearMonth({ exifShotAt, lastModified }), { year: 2025, month: 6 });
  assert.deepEqual(resolveYearMonth({ lastModified }), { year: 2024, month: 3 });
});

test('tagsFor 去重，相册名等于年份时只剩一个', () => {
  assert.deepEqual(tagsFor('2026', 2026), ['2026']);
  assert.deepEqual(tagsFor('家人', 2026), ['家人', '2026']);
});

test('sha256 与 id 前 12 位稳定', () => {
  const hex = sha256(Buffer.from('album'));
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(hex.slice(0, 12), sha256(Buffer.from('album')).slice(0, 12));
});
