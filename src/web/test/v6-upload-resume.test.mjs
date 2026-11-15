import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILURE_KINDS, FAILURE_LABELS, classifyFailure, failureLabel,
  remainingParts, bytesForParts, signedStillValid, SIGNED_TTL_MS,
  photoIdFor, PART_SIZE_HINT,
} from '../js/upload-state.js';

/**
 * V6 T-21 上传断点续传与闭环。
 *
 * 四条判据落在这里：
 *   1. 8 MB 以上文件中断后续传字节数 < 全量 → `remainingParts` / `bytesForParts`
 *   2. 失败原因归五类且文案不泄露 URL / 状态码 / 对象 key → `classifyFailure` / `failureLabel`
 *   3. 「去看看」能定位 → `photoIdFor` 与处理函数同一条规则（sha 前 12 位）
 *   4. 只有同一次签名内能续 → `signedStillValid`
 *
 * 第 4 条是这次任务里最重要的**边界声明**：服务端每次取地址都新建 uploadId，
 * 所以旧 etag 对新 uploadId 无效，跨刷新续传需要服务端 ListParts，不在本次范围。
 */

const MB = 1024 * 1024;

test('五类失败：按用户能做什么分类', () => {
  assert.equal(classifyFailure({ status: 0 }), 'network', '连接层失败一律算网络');
  assert.equal(classifyFailure({ status: 401 }), 'auth');
  assert.equal(classifyFailure({ status: 403 }), 'auth');
  assert.equal(classifyFailure({ status: 413 }), 'too-large');
  assert.equal(classifyFailure({ status: 415 }), 'unsupported');
  assert.equal(classifyFailure({ status: 500 }), 'server');
  assert.equal(classifyFailure({ status: 503 }), 'server');
  assert.equal(classifyFailure({ status: 418 }), 'server', '认不出的状态码算服务端，不能瞎猜成用户的错');
  assert.equal(classifyFailure({ retryable: true }), 'network');
  assert.equal(classifyFailure({}), 'server');
  assert.equal(classifyFailure(null), 'server');
});

test('失败种类：种类表与文案表一一对应', () => {
  // 原本是五类（T-21）。第六类 `unreadable` 是线上事故加的：系统把文件句柄
  // 回收之后重试没有意义，只能让用户重新选，它与前五类的「下一步动作」都不同。
  assert.deepEqual(
    [...FAILURE_KINDS],
    ['network', 'auth', 'too-large', 'unsupported', 'server', 'unreadable'],
  );
  for (const kind of FAILURE_KINDS) {
    assert.equal(typeof FAILURE_LABELS[kind], 'string');
    assert.ok(FAILURE_LABELS[kind].length > 0);
  }
  assert.equal(Object.keys(FAILURE_LABELS).length, FAILURE_KINDS.length);
});

test('失败文案不泄露 URL、状态码或对象 key', () => {
  const samples = [
    { status: 0 }, { status: 401 }, { status: 413 }, { status: 415 }, { status: 500 },
    { status: 403, retryable: false, message: 'https://s3.amazonaws.com/bucket/incoming/abc123.mp4 413' },
  ];
  for (const err of samples) {
    const text = failureLabel(err);
    assert.doesNotMatch(text, /https?:\/\//, `不能出现地址：${text}`);
    assert.doesNotMatch(text, /\/incoming\//, `不能出现对象 key：${text}`);
    assert.doesNotMatch(text, /\b[1-5]\d{2}\b/, `不能出现状态码：${text}`);
    assert.doesNotMatch(text, /\.(mp4|webp|jpg)\b/i, `不能出现文件名：${text}`);
  }
});

test('续传：只剩没传完的分片，字节数明显少于全量', () => {
  const total = 40 * MB;
  const parts = Array.from({ length: 5 }, (_, index) => ({
    partNumber: index + 1,
    url: `https://signed/${index + 1}`,
  }));
  const etags = [{ partNumber: 1, etag: 'e1' }, { partNumber: 2, etag: 'e2' }, { partNumber: 3, etag: 'e3' }];

  const todo = remainingParts(parts, etags);
  assert.deepEqual(todo.map((part) => part.partNumber), [4, 5]);

  const resent = bytesForParts(total, PART_SIZE_HINT, todo);
  assert.equal(resent, 16 * MB, '40 MB / 8 MB 正好 5 片，已传 3 片，剩 2 片 = 16 MB');
  assert.ok(resent < total, '续传字节数必须小于全量');
});

test('续传：一片都没传过时就是全量', () => {
  const total = 20 * MB;
  const parts = [1, 2, 3].map((partNumber) => ({ partNumber }));
  const resent = bytesForParts(total, PART_SIZE_HINT, remainingParts(parts, []));
  assert.equal(resent, total);
});

test('续传：全部都传过时一片都不发', () => {
  const parts = [{ partNumber: 1 }, { partNumber: 2 }];
  const etags = [{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }];
  assert.equal(remainingParts(parts, etags).length, 0);
  assert.equal(bytesForParts(20 * MB, PART_SIZE_HINT, []), 0);
});

test('续传边界：预签名过期就不再复用 uploadId', () => {
  const now = Date.parse('2026-11-15T10:00:00Z');
  assert.equal(signedStillValid(now - 60_000, now), true);
  assert.equal(signedStillValid(now - SIGNED_TTL_MS + 1000, now), true);
  assert.equal(signedStillValid(now - SIGNED_TTL_MS, now), false, '超过 14 分钟就该重新取地址');
  assert.equal(signedStillValid(undefined, now), false);
  assert.equal(signedStillValid(0, now), false);
  assert.ok(SIGNED_TTL_MS < 15 * 60 * 1000, '要留出比服务端 15 分钟更短的余量');
});

test('「去看看」用的 ID 规则与服务端一致：sha 前 12 位', () => {
  const sha = 'a75ad99f29dd4c1e8b2f';
  assert.equal(photoIdFor(sha), 'a75ad99f29dd');
  assert.equal(photoIdFor('0123456789abcdef'), '0123456789ab');
  for (const bad of ['', null, undefined, 'short', 'zzzzzzzzzzzzzz', 42]) {
    assert.equal(photoIdFor(bad), '', `${String(bad)} 应当给空串，别拼出一个假 ID`);
  }
});

test('服务端规则对得上：handler 里就是 slice(0, 12)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../server/processor/handler.mjs', import.meta.url), 'utf8');
  assert.match(source, /const id = sha\.slice\(0, 12\)/, '两侧规则必须一致，否则「去看看」会稳定跳空');
});
