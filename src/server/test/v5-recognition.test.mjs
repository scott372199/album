import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildRecognitionInput, validateRecognitionInput, buildIdempotencyKey,
  isRedactedDerivative, isIncomingOriginal, RecognitionInputError,
  SOURCE_ASSET_PATTERN, ASSET_ID_PATTERN, CONTENT_HASH_PATTERN,
} from '../recognition/input.mjs';
import {
  RecognitionProvider, assertProvider, normalizeLabels, assertNoRawResponse,
  toEventLabels, isFiniteConfidence, RecognitionProviderError,
  isRetryableProviderError, LABEL_KINDS, RETRYABLE_ERROR_CLASSES,
} from '../recognition/provider.mjs';
import {
  normalizeRekognitionResponse, buildDetectLabelsParams,
  createRekognitionProvider, createFixtureProvider, ZH_LABEL_DICT, EN_TERM_MAP,
} from '../recognition/rekognition.mjs';
import {
  createWorker, createMemoryQueue, createInMemoryDedupe,
  buildRecognitionEvent, parseMessageBody,
} from '../recognition/worker.mjs';
import {
  createMemoryLogger, STRUCTURED_LOG_REQUIRED, OBSERVABILITY_FORBIDDEN_FIELDS,
  safeObjectKeyDigest,
} from '../v5/correlation.mjs';

/**
 * V5 识别链路测试：输入边界、规范化标签、raw response 守卫、worker 幂等/重试/DLQ。
 * 夹具只用占位 id 与相对路径，无手机号、令牌、密钥或绝对路径。
 *
 * V5 recognition tests: input boundary, label normalization, raw-response guard,
 * worker idempotency/retry/DLQ. Fixtures use placeholder ids and relative paths.
 */
const ID = 'abcdef012345';
const HASH = createHash('sha256').update('fixture').digest('hex');
const KEY = `photos/${ID}/grid.webp`;
const CORR = 'corr_0123456789abcdef';
const good = { assetId: ID, contentHash: HASH, sourceAsset: KEY, correlationId: CORR };
const message = (over = {}) => ({
  body: JSON.stringify({ ...good, ...over }),
  receiptHandle: `rh-${Math.random().toString(36).slice(2, 8)}`,
  attempt: 1,
});
const sampleLabels = () => [
  { term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.92 },
  { term: 'car', zh: '汽车', kind: 'object', confidence: 0.81 },
];

/* ---------------- 输入边界 / Input boundary ---------------- */

test('合法派生图 grid/view 通过，incoming 原图一律拒绝', () => {
  assert.ok(isRedactedDerivative(KEY));
  assert.ok(isRedactedDerivative(`photos/${ID}/view.webp`));
  assert.ok(isIncomingOriginal('incoming/a.jpg'));
  assert.ok(!isRedactedDerivative('incoming/a.jpg'));
  assert.ok(!isRedactedDerivative(`photos/${ID}/thumb.webp`));
  assert.ok(SOURCE_ASSET_PATTERN.test(KEY));
  assert.ok(ASSET_ID_PATTERN.test(ID));
  assert.ok(CONTENT_HASH_PATTERN.test(HASH));
});

test('incoming/ 原图得到专门的 errorClass，绝不进入识别调用', () => {
  try {
    buildRecognitionInput({ ...good, sourceAsset: 'incoming/a.jpg' });
    assert.fail('原图必须被拒绝');
  } catch (err) {
    assert.ok(err instanceof RecognitionInputError);
    assert.equal(err.errorClass, 'incoming-original-rejected');
  }
});

test('非法 sourceAsset / assetId / contentHash / id 不一致全部拒绝', () => {
  const cases = [
    [{ ...good, sourceAsset: `photos/${ID}/thumb.webp` }, 'invalid-source-asset'],
    [{ ...good, sourceAsset: `photos/${ID}/grid.jpg` }, 'invalid-source-asset'],
    [{ ...good, contentHash: HASH.toUpperCase() }, 'invalid-content-hash'],
    [{ ...good, contentHash: 'abc' }, 'invalid-content-hash'],
    [{ ...good, assetId: 'XYZ' }, 'invalid-asset-id'],
    [{ ...good, assetId: '000000000000' }, 'asset-id-mismatch'],
  ];
  for (const [input, errorClass] of cases) {
    assert.throws(() => validateRecognitionInput(input), (err) => err.errorClass === errorClass,
      `应拒绝 ${errorClass}`);
  }
});

test('幂等键 = sha256(assetId:contentHash:sourceAsset)，且确定性', () => {
  const input = buildRecognitionInput(good);
  const expected = createHash('sha256')
    .update(`${ID}:${HASH}:${KEY}`, 'utf8').digest('hex');
  assert.equal(input.idempotencyKey, expected);
  assert.equal(buildIdempotencyKey(good), buildIdempotencyKey({ ...good }));
  assert.notEqual(buildIdempotencyKey(good), buildIdempotencyKey({ ...good, contentHash: HASH.replace(/.$/, '0') }));
  assert.equal(input.correlationId, CORR);
  // vendor-neutral：不含 S3Object / Bucket / command 字段
  assert.deepEqual(Object.keys(input.image), ['key']);
  assert.ok(!JSON.stringify(input).includes('S3Object'));
});

/* ---------------- Provider port / 端口 ---------------- */

test('RecognitionProvider 是抽象 port，assertProvider 接受鸭子类型 fake', async () => {
  await assert.rejects(() => new RecognitionProvider().detectLabels({}), /must be implemented/);
  assert.throws(() => assertProvider({}), TypeError);
  assert.equal(assertProvider({ detectLabels: async () => ({ labels: [] }) }).detectLabels instanceof Function, true);
});

test('normalizeLabels 只保留四个白名单字段、去重、确定性排序', () => {
  const labels = normalizeLabels([
    { term: 'Car', zh: '汽车', kind: 'object', confidence: 0.6, rawModelResponse: {} },
    { term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.92, extra: 'leak' },
    { term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.8 },
  ]);
  assert.equal(labels.length, 2);
  assert.deepEqual(Object.keys(labels[0]).sort(), ['confidence', 'kind', 'term', 'zh']);
  assert.equal(labels[0].term, 'lake');
  assert.ok(!('extra' in labels[0]) && !('rawModelResponse' in labels[1]));
  assert.ok(labels[0].confidence >= labels[1].confidence);
});

test('置信度必须是单个 float；string / NaN / 数组 / 越界都拒绝', () => {
  for (const confidence of ['0.9', Number.NaN, [0.9], Infinity, -0.1, 1.2]) {
    assert.equal(isFiniteConfidence(confidence), false, `${confidence}`);
    assert.throws(() => normalizeLabels([
      { term: 'x', zh: 'x', kind: 'object', confidence },
    ]), /invalid normalized label/);
  }
  assert.equal(isFiniteConfidence(0.9), true);
  assert.deepEqual(LABEL_KINDS, ['object', 'scene', 'color']);
});

test('任何情况下不返回 raw response：顶层与嵌套禁止字段都被守卫', () => {
  for (const dirty of [
    { labels: [], rawModelResponse: {} },
    { labels: [], Labels: [{ Name: 'x' }] },
    { labels: [], ResponseMetadata: { RequestId: 'x' } },
    { labels: [], nested: { phone: 'leak', token: 'leak' } },
  ]) {
    assert.throws(() => assertNoRawResponse(dirty));
  }
  assert.deepEqual(assertNoRawResponse({ labels: sampleLabels(), provider: 'fixture' }).labels.length, 2);
});

test('toEventLabels 转成 recognition.event 的 name/confidence/category 形状', () => {
  assert.deepEqual(toEventLabels(sampleLabels()), [
    { name: 'lake', confidence: 0.92, category: 'scene' },
    { name: 'car', confidence: 0.81, category: 'object' },
  ]);
});

test('供应商错误分类：可重试类别与 retryable 标记', () => {
  for (const errorClass of RETRYABLE_ERROR_CLASSES) {
    const err = new RecognitionProviderError('x', { errorClass });
    assert.equal(isRetryableProviderError(err), true);
  }
  const permanent = new RecognitionProviderError('x', { errorClass: 'provider-invalid', retryable: false });
  assert.equal(isRetryableProviderError(permanent), false);
  assert.equal(isRetryableProviderError(new Error('boom')), false);
});

/* ---------------- Rekognition adapter ---------------- */

const awsResponse = () => ({
  Labels: [
    { Name: 'Lake', Confidence: 92, Categories: [{ Name: 'Nature and Outdoors' }] },
    { Name: 'Car', Confidence: 81, Categories: [{ Name: 'Vehicles' }] },
    { Name: 'Motorcycle', Confidence: 77, Categories: [{ Name: 'Vehicles' }] },
  ],
  ImageProperties: {
    DominantColors: [
      { SimplifiedColor: 'RED', PixelPercent: 40 },
      { SimplifiedColor: 'BLUE', PixelPercent: 12 },
    ],
  },
  ResponseMetadata: { RequestId: 'x' },
});

test('DetectLabels 参数含 Image Properties，且只引用脱敏派生图', () => {
  const params = buildDetectLabelsParams(buildRecognitionInput(good), { bucket: 'placeholder' });
  assert.deepEqual(params.Features, ['GENERAL_LABELS', 'IMAGE_PROPERTIES']);
  assert.equal(params.Image.S3Object.Name, KEY);
  assert.equal(params.Image.S3Object.Bucket, 'placeholder');
  assert.ok(!JSON.stringify(params).includes('incoming/'));
});

test('normalizeRekognitionResponse 产出中文标签与 Image Properties 主色', () => {
  const labels = normalizeRekognitionResponse(awsResponse());
  assert.ok(labels.some((l) => l.term === 'lake' && l.zh === '湖水' && l.kind === 'scene'));
  assert.ok(labels.some((l) => l.term === 'car' && l.zh === '汽车' && l.kind === 'object'));
  assert.ok(labels.some((l) => l.term === 'red' && l.zh === '红色' && l.kind === 'color'));
  assert.ok(labels.some((l) => l.term === 'blue' && l.kind === 'color'));
  assert.ok(labels.every((l) => typeof l.confidence === 'number'
    && l.confidence >= 0 && l.confidence <= 1));
  // raw 字段绝不出现在结果里
  assert.ok(!JSON.stringify(labels).includes('ResponseMetadata'));
  assert.ok(!labels.some((l) => 'Name' in l || 'Confidence' in l));
  assert.equal(ZH_LABEL_DICT['湖水'] === undefined, true, '词典键是规范词');
  assert.equal(EN_TERM_MAP.lake, 'lake');
  assert.equal(EN_TERM_MAP.sky, 'blue sky');
});

test('createRekognitionProvider 注入 SDK gate，结果不含 raw', async () => {
  let seen = null;
  const provider = createRekognitionProvider({
    callDetectLabels: async (params) => { seen = params; return awsResponse(); },
    bucket: 'placeholder',
  });
  const result = await provider.detectLabels(buildRecognitionInput(good));
  assert.equal(seen.Image.S3Object.Name, KEY);
  assert.ok(result.labels.length > 0);
  assert.equal(result.provider, 'aws-rekognition');
  assert.deepEqual(Object.keys(result).sort(), ['labels', 'provider']);
  assert.ok(!('ResponseMetadata' in result));
  // 二次防线：即使调用方绕过 input.mjs，provider 也拒绝原图
  await assert.rejects(() => provider.detectLabels({ ...buildRecognitionInput(good), sourceAsset: 'incoming/a.jpg' }),
    /non-redacted|原图/);
});

test('createFixtureProvider 返回预置标签，并按 failAssets 模拟可重试失败', async () => {
  const fx = createFixtureProvider({ labelsByAsset: new Map([[ID, sampleLabels()]]) });
  const result = await fx.detectLabels(buildRecognitionInput(good));
  assert.equal(result.labels[0].term, 'lake');
  const bad = createFixtureProvider({ failAssets: new Set([ID]), errorClass: 'provider-throttled' });
  await assert.rejects(() => bad.detectLabels(buildRecognitionInput(good)),
    (err) => err.errorClass === 'provider-throttled' && isRetryableProviderError(err));
});

/* ---------------- Worker ---------------- */

test('成功路径：事件符合形状、日志必填齐全、correlation ID 贯通', async () => {
  const queue = createMemoryQueue([message()]);
  const logger = createMemoryLogger();
  const events = [];
  const worker = createWorker({
    queue, provider: createFixtureProvider({ labelsByAsset: new Map([[ID, sampleLabels()]]) }),
    dedupe: createInMemoryDedupe(), logger, onOutcome: (e) => events.push(e),
  });
  const results = await worker.run();
  assert.equal(results[0].outcome, 'success');
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.event, 'recognition.completed');
  assert.equal(event.status, 'success');
  assert.equal(event.correlationId, CORR);
  assert.deepEqual(event.labels, [
    { name: 'lake', confidence: 0.92, category: 'scene' },
    { name: 'car', confidence: 0.81, category: 'object' },
  ]);
  assert.ok(logger.events.length >= 1);
  for (const log of logger.events) {
    for (const key of STRUCTURED_LOG_REQUIRED) assert.ok(key in log, `日志缺 ${key}`);
    assert.ok('provider' in log && 'errorClass' in log);
    assert.equal(log.correlationId, CORR);
    assert.ok(log.durationMs >= 0);
    // 日志用安全摘要，不含对象 key 明文
    assert.ok(!JSON.stringify(log).includes(KEY));
    assert.equal(log.objectKeyDigest, safeObjectKeyDigest(KEY));
  }
  assert.equal(queue.acked.length, 1);
});

test('重复事件幂等：provider 只调用一次，不产生第二条建议', async () => {
  const queue = createMemoryQueue([message(), message()]);
  const callLog = [];
  const events = [];
  const worker = createWorker({
    queue,
    provider: createFixtureProvider({ labelsByAsset: new Map([[ID, sampleLabels()]]), callLog }),
    logger: createMemoryLogger(), onOutcome: (e) => events.push(e),
  });
  const results = await worker.run();
  assert.deepEqual(results.map((r) => r.outcome), ['success', 'duplicate']);
  assert.equal(callLog.length, 1);
  assert.equal(events.length, 1);
  assert.ok(events.every((e) => e.status === 'success'));
});

test('瞬时失败重试，最终失败进 DLQ，但仍发出 failed 事件', async () => {
  const queue = createMemoryQueue([message()]);
  const logger = createMemoryLogger();
  const events = [];
  const worker = createWorker({
    queue, provider: createFixtureProvider({ failAssets: new Set([ID]), errorClass: 'provider-timeout' }),
    logger, maxAttempts: 3, onOutcome: (e) => events.push(e),
  });
  const results = await worker.run();
  assert.deepEqual(results.map((r) => r.outcome), ['retry', 'retry', 'dlq']);
  assert.equal(queue.retries.length, 2);
  assert.equal(queue.dlq.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'failed');
  assert.equal(events[0].errorClass, 'provider-timeout');
  assert.deepEqual(events[0].labels, []);
  assert.ok(logger.events.some((e) => e.outcome === 'retry'));
  assert.ok(logger.events.some((e) => e.outcome === 'failure'));
});

test('坏事件（含 incoming 原图）直接进 DLQ，不重试、不产生识别事件', async () => {
  const queue = createMemoryQueue([message({ sourceAsset: 'incoming/a.jpg' })]);
  const events = [];
  const worker = createWorker({
    queue, provider: createFixtureProvider({}), logger: createMemoryLogger(),
    onOutcome: (e) => events.push(e),
  });
  const results = await worker.run();
  assert.equal(results[0].outcome, 'dlq');
  assert.equal(results[0].errorClass, 'incoming-original-rejected');
  assert.equal(queue.dlq.length, 1);
  assert.equal(queue.retries.length, 0);
  assert.equal(events.length, 0);
});

test('worker 与 processor 发布解耦：源码不 import 任何 processor 模块', async () => {
  const source = await readFile(new URL('../recognition/worker.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('../processor/') && !source.includes('processor/handler'));
  assert.ok(source.includes('DLQ'));
});

test('buildRecognitionEvent 支持三种状态，parseMessageBody 容错坏 JSON', () => {
  const input = buildRecognitionInput(good);
  for (const status of ['success', 'failed', 'skipped']) {
    const event = buildRecognitionEvent({ input, correlationId: CORR, status });
    assert.equal(event.status, status);
    assert.match(event.eventId, /^evt_[0-9a-f]{16}$/);
    assert.equal(event.sourceAsset, KEY);
  }
  assert.throws(() => buildRecognitionEvent({ input, correlationId: CORR, status: 'bogus' }));
  assert.deepEqual(parseMessageBody({ body: '{bad' }), {});
  assert.deepEqual(parseMessageBody({ body: { a: 1 } }), { a: 1 });
});

test('日志的 forbiddenFields 与契约 observability 段一致', () => {
  const logger = createMemoryLogger();
  logger.emit({
    event: 'recognition.completed', correlationId: CORR, stage: 'recognition',
    outcome: 'success', durationMs: 1, phone: 'leak', token: 'leak',
    originalUrl: 'leak', rawModelResponse: {}, nested: { secret: 'leak' },
  });
  const text = JSON.stringify(logger.events);
  for (const field of OBSERVABILITY_FORBIDDEN_FIELDS) {
    assert.ok(!text.includes(`"${field}"`), `日志出现禁止字段 ${field}`);
  }
});
