import test from 'node:test';
import assert from 'node:assert/strict';
import { planFiles, signableHeaderNames } from '../auth/rules.mjs';

test('签名头包含 content-type 与全部 x-amz-meta-*', () => {
  const names = signableHeaderNames('image/jpeg', {
    album: 'ZmFtaWx5',
    'taken-at': 'MjAyNi0wNS0wMVQwMDowMDowMC4wMDBa',
    sha256: 'a'.repeat(64),
  });
  assert.deepEqual(names, [
    'content-type',
    'x-amz-meta-album',
    'x-amz-meta-taken-at',
    'x-amz-meta-sha256',
  ]);
});

test('元数据为空时只签 content-type', () => {
  assert.deepEqual(signableHeaderNames('video/mp4', {}), ['content-type']);
});

test('已经带 x-amz-meta- 前缀的名字不会被重复加前缀', () => {
  assert.deepEqual(
    signableHeaderNames('image/png', { 'x-amz-meta-sha256': 'abc' }),
    ['content-type', 'x-amz-meta-sha256'],
  );
});

test('缺 content-type 时不写进签名，避免出现空值头', () => {
  assert.deepEqual(signableHeaderNames('', { album: 'YQ==' }), ['x-amz-meta-album']);
});

test('planFiles 给出的元数据键与签名头一一对应', () => {
  const plan = planFiles([{ name: 'a.jpg', size: 1, sha256: 'b'.repeat(64) }], {
    maxFiles: 3,
    maxImage: 1024,
    maxVideo: 1024,
    prefix: 'incoming/',
    album: '家人',
  });
  const entry = plan.items[0];
  const metadata = Object.fromEntries(
    Object.entries(entry.metadata).filter(([, value]) => value !== ''),
  );
  assert.deepEqual(
    signableHeaderNames(entry.contentType, metadata),
    ['content-type', 'x-amz-meta-album', 'x-amz-meta-sha256'],
  );
});
