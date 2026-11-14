import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CORRELATION_ID_PATTERN, STRUCTURED_LOG_REQUIRED, buildLogEvent,
  correlationIdFor, invalidationCallerReference, trace,
} from '../v5/correlation.mjs';
import { planFiles } from '../auth/rules.mjs';
import { recognizeGrid, publishRecognition } from '../processor/recognition.mjs';

/**
 * correlation ID 全链路单测：全离线、零依赖安装。
 *
 * 目标不是「有一个 corr_ 字符串」，而是证明同一个 ID 能从预签名元数据，
 * 一路贯穿 S3 事件、processor、清单发布、识别、索引发布和 CDN 失效，
 * 且每一条结构化日志都满足契约必填字段。
 *
 * Offline, zero-install tests for the correlation trace. The point is not
 * merely that a corr_ string exists: the same ID must survive presign
 * metadata, the S3 event, the processor, manifest publication, recognition,
 * index publishing and CDN invalidation, with every structured log line
 * carrying the contract's required fields.
 */
const KEY = 'incoming/0123456789abcdef.jpg';
const ID = 'abcdef012345';
const GRID = Buffer.from('RIFF-webp-fixture');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const LIMITS = {
  maxFiles: 5,
  maxImage: 30 * 1024 * 1024,
  maxVideo: 200 * 1024 * 1024,
  prefix: 'incoming/',
  album: '家人',
};
const file = (overrides = {}) => ({
  name: 'a.jpg', size: 1024, sha256: 'a'.repeat(64), ...overrides,
});

/** 捕获 trace 写出的 JSON 行（含 lib/log 的普通行，按字段过滤掉）。 */
async function captureTraces(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return lines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((event) => event && typeof event.correlationId === 'string' && 'stage' in event);
}

/* ---------------- ID 解析 / ID resolution ---------------- */

test('correlationIdFor：优先用合法元数据，非法或缺失时按 key 确定性兜底', () => {
  const valid = 'corr_0123456789abcdef';
  assert.equal(correlationIdFor({ key: KEY, metadata: { 'correlation-id': valid } }), valid);
  assert.equal(
    correlationIdFor({ key: KEY, metadata: { 'x-amz-meta-correlation-id': valid } }),
    valid,
  );

  const digest = `corr_${createHash('sha256').update(KEY, 'utf8').digest('hex').slice(0, 16)}`;
  assert.equal(correlationIdFor({ key: KEY }), digest);
  assert.equal(correlationIdFor({ key: KEY, metadata: {} }), digest);
  assert.equal(correlationIdFor({ key: KEY, metadata: { 'correlation-id': '../evil' } }), digest);
  assert.equal(correlationIdFor({ key: KEY, metadata: { 'correlation-id': 'CORR_ABC' } }), digest);
  // 同一个对象重算多少次都一样：重试 / 事件回放 / 合并分片都接得上
  assert.equal(correlationIdFor({ key: KEY }), correlationIdFor({ key: KEY }));
  // 不同对象不能撞 ID
  assert.notEqual(correlationIdFor({ key: KEY }), correlationIdFor({ key: `${KEY}2` }));
  assert.match(correlationIdFor({ key: '' }), CORRELATION_ID_PATTERN);
});

test('planFiles 把同一个 ID 写进顶层字段与 x-amz-meta-correlation-id', () => {
  const plan = planFiles([file()], LIMITS);
  const item = plan.items[0];
  assert.match(item.correlationId, CORRELATION_ID_PATTERN);
  assert.equal(item.metadata['correlation-id'], item.correlationId);
  assert.equal(correlationIdFor({ key: item.key, metadata: item.metadata }), item.correlationId);
});

test('planFiles 接受合法的 corr_… 覆盖，非法输入一律忽略而不是原样写进 S3', () => {
  const override = 'corr_fedcba9876543210';
  const ok = planFiles(
    [file(), file({ sha256: 'b'.repeat(64) })],
    { ...LIMITS, correlationId: override },
  );
  assert.equal(ok.items.length, 2);
  for (const item of ok.items) {
    assert.equal(item.correlationId, override);
    assert.equal(item.metadata['correlation-id'], override);
  }

  const bad = planFiles([file()], { ...LIMITS, correlationId: 'javascript:alert(1)' });
  assert.match(bad.items[0].correlationId, CORRELATION_ID_PATTERN);
  assert.notEqual(bad.items[0].correlationId, 'javascript:alert(1)');
});

test('CloudFront CallerReference 带上 ID，且每次请求唯一', () => {
  const corr = 'corr_0123456789abcdef';
  const first = invalidationCallerReference(corr);
  const second = invalidationCallerReference(corr);
  assert.ok(first.includes(corr));
  assert.notEqual(first, second, '同一秒内重试也不能被 CloudFront 去重');
  assert.ok(!invalidationCallerReference('../evil').includes('..'));
});

/* ---------------- 结构化日志守卫 / structured-log guards ---------------- */

test('buildLogEvent 补齐必填字段、剔除禁止字段，stage 必须在契约内', () => {
  const event = buildLogEvent({
    event: 'process.done', correlationId: 'corr_0123456789abcdef',
    stage: 'processor', outcome: 'success', durationMs: 12,
    token: 'must-not-appear', assetId: ID,
  });
  for (const field of STRUCTURED_LOG_REQUIRED) assert.ok(field in event);
  assert.equal(event.assetId, ID);
  assert.equal(event.provider, null);
  assert.equal(event.errorClass, null);
  assert.ok(!('token' in event));
  assert.throws(() => buildLogEvent({ event: 'x', stage: 'not-a-stage' }), /stage|missing/);
});

test('trace 的字段写错只留 warn，不抛错打断上传', async () => {
  const events = await captureTraces(() => {
    assert.equal(trace({ event: 'x', correlationId: 'corr_a', stage: 'unknown-stage', outcome: 'x' }), null);
    trace({
      event: 'upload.presigned', correlationId: 'corr_0123456789abcdef',
      stage: 'upload', outcome: 'success', durationMs: 1,
    });
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'upload');
});

/* ---------------- 一次上传的全链路 trace / one-upload trace ---------------- */

/** 与 v5-processor-recognition 测试同样的内存 store 替身。 */
function memoryStore() {
  const objects = new Map();
  return {
    objects,
    CACHE_IMMUTABLE: 'public, max-age=31536000, immutable',
    CACHE_NO_STORE: 'no-store',
    async putJson(bucket, key, value) { objects.set(key, Buffer.from(JSON.stringify(value))); },
    async putBuffer(bucket, key, body) { objects.set(key, body); },
    async readJson(bucket, key) {
      const body = objects.get(key);
      return body ? JSON.parse(body.toString('utf8')) : null;
    },
    async listKeys(bucket, prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

test('同一次上传：upload → processor → publish → recognition → index → invalidation 共用唯一 ID', async () => {
  // 1) 预签名：服务端算出 ID 并写进 S3 元数据
  const item = planFiles([file({ sha256: 'c'.repeat(64) })], LIMITS).items[0];
  const correlationId = item.correlationId;

  // 2) S3 事件到 processor：从对象元数据恢复（等价于 store.head() 的 Metadata）
  const recovered = correlationIdFor({ key: item.key, metadata: item.metadata });
  assert.equal(recovered, correlationId);

  const store = memoryStore();
  store.objects.set('data/version.json', Buffer.from(JSON.stringify({
    rev: 'a1b2c3d4e5f6', manifest: 'data/manifest.json',
  })));
  store.objects.set('data/manifest.json', Buffer.from(JSON.stringify({
    photos: [{ id: ID, type: 'image', year: 2025, month: 6, tags: [] }],
  })));

  const events = await captureTraces(async () => {
    // 3) auth /upload-url
    trace({
      event: 'upload.presigned', correlationId, stage: 'upload',
      outcome: 'success', durationMs: 3,
    });
    // 4) processor 起点 + 清单发布（handler.mjs 中由 commitManifest 发出）
    trace({
      event: 'process.started', correlationId, stage: 'processor',
      outcome: 'started', durationMs: 0,
    });
    trace({
      event: 'manifest.published', correlationId, stage: 'publish',
      outcome: 'success', durationMs: 20, assetId: ID, attempt: 1,
    });
    // 5) 识别 + 索引发布（真实模块，注入零依赖替身）
    const recognition = await recognizeGrid({
      assetId: ID,
      gridBuffer: GRID,
      correlationId,
      convertToJpeg: async () => JPEG,
      callDetectLabels: async () => ({
        Labels: [{ Name: 'Lake', Confidence: 95, Categories: [{ Name: 'Nature' }] }],
      }),
    });
    await publishRecognition({
      siteBucket: 'site', assetId: ID, recognition, correlationId, io: { store },
    });
    // 6) CDN 失效
    trace({
      event: 'invalidation.created', correlationId, stage: 'invalidation',
      outcome: 'success', durationMs: 4, assetId: ID,
    });
    trace({
      event: 'process.done', correlationId, stage: 'processor',
      outcome: 'success', durationMs: 3400, assetId: ID,
    });
  });

  assert.ok(events.length >= 7, `事件太少，链路断了：${events.length}`);
  for (const event of events) {
    assert.equal(event.correlationId, correlationId, `${event.event} 丢了追踪 ID`);
    for (const field of STRUCTURED_LOG_REQUIRED) {
      assert.ok(field in event, `${event.event} 缺 ${field}`);
    }
  }
  const stages = new Set(events.map((event) => event.stage));
  for (const stage of ['upload', 'processor', 'publish', 'recognition', 'index', 'invalidation']) {
    assert.ok(stages.has(stage), `缺少 ${stage} 阶段的结构化日志`);
  }
  assert.ok(store.objects.has('data/search-index.json'), '索引确实发布了');
});
