import test from 'node:test';
import assert from 'node:assert/strict';
import { planFiles, sanitizeAlbum, extensionOf, DEFAULT_ALBUM } from '../auth/rules.mjs';

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
