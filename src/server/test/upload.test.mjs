import test from 'node:test';
import assert from 'node:assert/strict';
import { planFiles, metadataHeaderNames, signableHeaderNames } from '../auth/rules.mjs';

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
  assert.deepEqual(metadataHeaderNames({}), []);
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

test('元数据头既要进签名，也要禁止被提到查询串', () => {
  // 只给 signableHeaders 时，SDK 仍然会把 x-amz-meta-* 提到 query，
  // 签名头只剩 content-type;host —— 实测 403 headers not signed。
  const metas = metadataHeaderNames({ album: 'YQ==', sha256: 'b'.repeat(64) });
  assert.deepEqual(metas, ['x-amz-meta-album', 'x-amz-meta-sha256']);
  // 同一批名字必须同时出现在 signableHeaders 给的那份清单里
  const signable = signableHeaderNames('image/jpeg', { album: 'YQ==', sha256: 'b'.repeat(64) });
  for (const name of metas) assert.ok(signable.includes(name), `${name} 也应在签名范围内`);
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
    ['content-type', 'x-amz-meta-album', 'x-amz-meta-sha256', 'x-amz-meta-correlation-id'],
  );
  // correlation-id 必须同时进签名范围与 S3 元数据，否则客户端发出去的
  // 自定义头会被判成「未签名头」回 403。
  // The correlation-id header must be signed AND present on the object.
  assert.equal(entry.metadata['correlation-id'], entry.correlationId);
  assert.match(entry.correlationId, /^corr_[0-9a-f]{16}$/);
});
