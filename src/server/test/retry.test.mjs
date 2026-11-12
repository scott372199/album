import test from 'node:test';
import assert from 'node:assert/strict';
import { isPreconditionFailed, backoffMs } from '../lib/retry.mjs';

// 这些判定的语义是从 S3 的实际行为反推的：条件写失败给 412，同键并发写
// 偶尔给 409。认错任何一个，批量上传的照片就会在清单里静默丢条。
// The semantics come from observed S3 behaviour; getting them wrong makes
// batch uploads silently lose manifest entries.

test('412 与 PreconditionFailed 都算前置条件失败', () => {
  assert.equal(isPreconditionFailed({ $metadata: { httpStatusCode: 412 } }), true);
  assert.equal(isPreconditionFailed({ name: 'PreconditionFailed' }), true);
});

test('409 ConditionalRequestConflict 也算（同键并发写）', () => {
  assert.equal(isPreconditionFailed({ $metadata: { httpStatusCode: 409 } }), true);
  assert.equal(isPreconditionFailed({ name: 'ConditionalRequestConflict' }), true);
});

test('其它错误不算，否则会无限重试', () => {
  // 权限错误重试多少次都不会成功，必须原样抛出
  assert.equal(isPreconditionFailed({ $metadata: { httpStatusCode: 403 } }), false);
  assert.equal(isPreconditionFailed({ name: 'NoSuchBucket' }), false);
  assert.equal(isPreconditionFailed(new Error('boom')), false);
  assert.equal(isPreconditionFailed(null), false);
  assert.equal(isPreconditionFailed(undefined), false);
});

test('退避随轮次增长，且带抖动', () => {
  const noJitter = () => 0;
  assert.equal(backoffMs(1, 50, noJitter), 50);
  assert.equal(backoffMs(3, 50, noJitter), 150);

  // 同样的轮次、不同的随机数应当给出不同的等待，否则两个实例会一直同步撞车
  const a = backoffMs(2, 50, () => 0);
  const b = backoffMs(2, 50, () => 0.99);
  assert.ok(b > a, '抖动必须能拉开等待时间');
});

test('退避对异常轮次有兜底，不会出现负数或无限等待', () => {
  const noJitter = () => 0;
  assert.ok(backoffMs(0, 50, noJitter) > 0);
  assert.ok(backoffMs(-3, 50, noJitter) > 0);
  assert.ok(backoffMs(1000, 50, noJitter) <= 500, '轮次再大也要封顶');
});
