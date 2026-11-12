import test from 'node:test';
import assert from 'node:assert/strict';
import { planFiles, sanitizeAlbum, extensionOf, DEFAULT_ALBUM } from '../auth/rules.mjs';
import {
  multipartPlan, parseComplete, MIN_PART_SIZE, MAX_PARTS,
} from '../auth/rules.mjs';

const LIMITS = {
  maxFiles: 3,
  maxImage: 30 * 1024 * 1024,
  maxVideo: 200 * 1024 * 1024,
  prefix: 'incoming/',
  album: '家人',
};

const file = (overrides = {}) => ({
  name: 'IMG_0001.JPG',
  size: 1024,
  sha256: 'a'.repeat(64),
  ...overrides,
});

test('扩展名统一小写，没有扩展名返回空串', () => {
  assert.equal(extensionOf('IMG_0001.HEIC'), '.heic');
  assert.equal(extensionOf('a.tar.gz'), '.gz');
  assert.equal(extensionOf('noext'), '');
});

test('相册名清掉控制字符与路径分隔符，超长截断', () => {
  assert.equal(sanitizeAlbum('  家人  '), '家人');
  assert.equal(sanitizeAlbum('a/b\\c'), 'a-b-c');
  assert.equal(sanitizeAlbum(''), DEFAULT_ALBUM);
  assert.equal(sanitizeAlbum('x'.repeat(100)).length, 40);
});

test('正常批次给出 key、content-type 与元数据', () => {
  const plan = planFiles([file()], LIMITS);
  assert.equal(plan.error, undefined);
  assert.equal(plan.items.length, 1);
  const [item] = plan.items;
  assert.equal(item.key, `incoming/${'a'.repeat(16)}.jpg`);
  assert.equal(item.contentType, 'image/jpeg');
  assert.equal(Buffer.from(item.metadata.album, 'base64url').toString('utf8'), '家人');
  assert.equal(item.metadata.sha256, 'a'.repeat(64));
});

test('同一批里内容相同的文件只签一次', () => {
  const plan = planFiles([file(), file({ name: 'copy.JPG' })], LIMITS);
  assert.equal(plan.items.length, 1);
});

test('超过数量上限整批拒绝，并说明上限', () => {
  const plan = planFiles([file(), file(), file(), file()], LIMITS);
  assert.deepEqual(plan, { error: 'too_many_files', max: 3 });
});

test('空批次与非法条目', () => {
  assert.deepEqual(planFiles([], LIMITS), { error: 'no_files' });
  assert.deepEqual(planFiles([file(), null], LIMITS), { error: 'invalid_file', index: 1 });
});

test('白名单外的扩展名一律拒绝——.html/.svg 能上传就等于开了 XSS 口子', () => {
  assert.equal(planFiles([file({ name: 'evil.html' })], LIMITS).error, 'unsupported_type');
  assert.equal(planFiles([file({ name: 'evil.svg' })], LIMITS).error, 'unsupported_type');
});

test('哈希必须是小写化的 64 位十六进制', () => {
  assert.equal(planFiles([file({ sha256: 'abc' })], LIMITS).error, 'invalid_sha256');
  assert.equal(planFiles([file({ sha256: 'A'.repeat(64) })], LIMITS).error, undefined);
});

test('体积上限按类型区分：图片 30MB，视频 200MB', () => {
  const big = 100 * 1024 * 1024;
  assert.equal(planFiles([file({ size: big })], LIMITS).error, 'file_too_large');
  assert.equal(planFiles([file({ name: 'clip.MOV', size: big })], LIMITS).error, undefined);

  const tooBig = 250 * 1024 * 1024;
  assert.equal(planFiles([file({ name: 'clip.mov', size: tooBig })], LIMITS).error, 'file_too_large');
});

test('体积为 0 或非数字都拒绝', () => {
  assert.equal(planFiles([file({ size: 0 })], LIMITS).error, 'invalid_size');
  assert.equal(planFiles([file({ size: 'big' })], LIMITS).error, 'invalid_size');
});

test('takenAt 归一成 ISO；非法值不写进元数据', () => {
  const ok = planFiles([file({ takenAt: '2026-11-01T07:30:00+08:00' })], LIMITS);
  assert.equal(ok.items[0].metadata['taken-at'], '2026-10-31T23:30:00.000Z');

  const bad = planFiles([file({ takenAt: '昨天' })], LIMITS);
  assert.equal(bad.items[0].metadata['taken-at'], '');
});

/* ---------------- 分片 ---------------- */

test('小文件不分片，超过阈值才分片', () => {
  const opts = { threshold: 16 * 1024 * 1024, partSize: 8 * 1024 * 1024 };
  assert.equal(multipartPlan(8 * 1024 * 1024, opts), null);
  assert.equal(multipartPlan(16 * 1024 * 1024, opts), null, '等于阈值仍走单次 PUT');
  assert.deepEqual(multipartPlan(16 * 1024 * 1024 + 1, opts), { parts: 3, partSize: 8 * 1024 * 1024 });
});

test('分片数按体积向上取整：200MB 刚好 25 片', () => {
  const plan = multipartPlan(200 * 1024 * 1024, { threshold: 1, partSize: 8 * 1024 * 1024 });
  assert.equal(plan.parts, 25);
});

test('片小于 5MB 直接拒绝——S3 的硬规矩，不是我们的偏好', () => {
  assert.deepEqual(
    multipartPlan(50 * 1024 * 1024, { threshold: 1, partSize: 1024 * 1024 }),
    { error: 'part_too_small' },
  );
  assert.equal(MIN_PART_SIZE, 5 * 1024 * 1024);
});

test('片数超过 10000 拒绝', () => {
  const plan = multipartPlan(MAX_PARTS * 8 * 1024 * 1024 + 1, {
    threshold: 1, partSize: 8 * 1024 * 1024,
  });
  assert.equal(plan.error, 'too_many_parts');
});

test('合并请求：key 必须落在 incoming/ 且形状与签发时一致', () => {
  const ok = { key: 'incoming/0123456789abcdef.mp4', uploadId: 'u1', parts: [{ partNumber: 1, etag: 'a'.repeat(32) }] };
  assert.equal(parseComplete(ok).error, undefined);
  assert.equal(parseComplete({ ...ok, key: 'photos/0123456789abcdef.mp4' }).error, 'invalid_key');
  assert.equal(parseComplete({ ...ok, key: 'incoming/whatever.mp4' }).error, 'invalid_key');
  assert.equal(parseComplete({ ...ok, key: '../incoming/0123456789abcdef.mp4' }).error, 'invalid_key');
});

test('合并请求：etag 必须是 S3 的形状（可带引号、可带 -N）', () => {
  const base = { key: 'incoming/0123456789abcdef.mp4', uploadId: 'u1' };
  assert.equal(parseComplete({ ...base, parts: [{ partNumber: 1, etag: `"${'b'.repeat(32)}"` }] }).error, undefined);
  assert.equal(parseComplete({ ...base, parts: [{ partNumber: 1, etag: `${'b'.repeat(32)}-2` }] }).error, undefined);
  assert.equal(parseComplete({ ...base, parts: [{ partNumber: 1, etag: 'nope' }] }).error, 'invalid_etag');
  assert.equal(parseComplete({ ...base, parts: [] }).error, 'invalid_parts');
  assert.equal(parseComplete({ ...base, parts: [{ partNumber: 0, etag: 'c'.repeat(32) }] }).error, 'invalid_part_number');
});

test('合并请求：片序号升序排序，乱序直接报 InvalidPartOrder', () => {
  const parsed = parseComplete({
    key: 'incoming/0123456789abcdef.mp4',
    uploadId: 'u1',
    parts: [
      { partNumber: 3, etag: 'c'.repeat(32) },
      { partNumber: 1, etag: 'a'.repeat(32) },
      { partNumber: 2, etag: 'b'.repeat(32) },
    ],
  });
  assert.deepEqual(parsed.parts.map((part) => part.PartNumber), [1, 2, 3]);
});
