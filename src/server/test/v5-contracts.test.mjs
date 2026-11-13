import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  CONTRACT, PUBLIC_FIELDS, FORBIDDEN_FIELDS, OBSERVABILITY_FORBIDDEN_FIELDS,
  STRUCTURED_LOG_REQUIRED, STRUCTURED_LOG_OPTIONAL, LOG_STAGES,
  CORRELATION_ID_HEADER, CORRELATION_ID_FORMAT, CORRELATION_PROPAGATION,
  CORRELATION_ID_PATTERN, isValidCorrelationId, generateCorrelationId,
  resolveCorrelationId, safeObjectKeyDigest, buildLogEvent, findForbidden,
  stripForbidden,
} from '../v5/correlation.mjs';
import { parseQuery, toQuery } from '../search/query.mjs';
import {
  search, createIndex, INDEX_VERSION, ITEM_FIELDS, SOURCES, RANKING, projectPublic,
} from '../search/index.mjs';
import {
  computeRev, ownership, SEARCH_INDEX_OWNER,
} from '../search/publish.mjs';
import { runVerticalSlice, defaultManifest, defaultLabels } from '../search/e2e.mjs';
import { buildRecognitionEvent } from '../recognition/worker.mjs';
import { buildRecognitionInput } from '../recognition/input.mjs';
import {
  PUBLIC_FIELDS as WEB_PUBLIC, FORBIDDEN_FIELDS as WEB_FORBIDDEN,
} from '../../web/js/search.js';

/**
 * 契约测试：v5-contracts.json 是唯一机器可读来源。
 * 用一个轻量 JSON Schema 校验器（覆盖本契约用到的关键字）验证真实产物，
 * 并做禁止字段扫描、correlation ID 贯通与写路径归属断言。
 *
 * Contract tests: the JSON is the single machine-readable source. A small
 * JSON Schema validator (covering the keywords this contract uses) checks
 * real artifacts, plus forbidden-field scans, correlation ID propagation and
 * write-path ownership assertions.
 */
const raw = JSON.parse(await readFile(
  new URL('../../../spec/v5/contracts/v5-contracts.json', import.meta.url), 'utf8',
));

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    default: return false;
  }
}

/** 覆盖 type/required/properties/additionalProperties/enum/const/范围/pattern/format。 */
function assertValid(instance, schema, path = '$') {
  if (schema.const !== undefined) {
    assert.equal(instance, schema.const, `${path}: const`);
    return;
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(instance), `${path}: enum`);
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    assert.ok(types.some((type) => matchesType(instance, type)),
      `${path}: 类型应为 ${types.join('|')}`);
  }
  if (typeof instance === 'number') {
    if (schema.minimum !== undefined) assert.ok(instance >= schema.minimum, `${path}: minimum`);
    if (schema.maximum !== undefined) assert.ok(instance <= schema.maximum, `${path}: maximum`);
    if (schema.exclusiveMinimum !== undefined) {
      assert.ok(instance > schema.exclusiveMinimum, `${path}: exclusiveMinimum`);
    }
  }
  if (typeof instance === 'string') {
    if (schema.maxLength !== undefined) assert.ok(instance.length <= schema.maxLength, `${path}: maxLength`);
    if (schema.pattern) assert.ok(new RegExp(schema.pattern).test(instance), `${path}: pattern`);
    if (schema.format === 'date-time') {
      assert.ok(!Number.isNaN(Date.parse(instance)), `${path}: date-time`);
    }
  }
  if (Array.isArray(instance)) {
    if (schema.maxItems !== undefined) assert.ok(instance.length <= schema.maxItems, `${path}: maxItems`);
    if (schema.items) instance.forEach((value, i) => assertValid(value, schema.items, `${path}[${i}]`));
  }
  if (instance && typeof instance === 'object' && !Array.isArray(instance)) {
    for (const key of schema.required || []) {
      assert.ok(Object.prototype.hasOwnProperty.call(instance, key), `${path}: 缺少必填 ${key}`);
    }
    const props = schema.properties || {};
    for (const [key, value] of Object.entries(instance)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        assertValid(value, props[key], `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        assert.fail(`${path}: 出现未声明字段 ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        assertValid(value, schema.additionalProperties, `${path}.${key}`);
      }
    }
  }
}

const CORR = 'corr_0123456789abcdef';
const ID = 'abcdef012345';
const KEY = `photos/${ID}/grid.webp`;
const input = buildRecognitionInput({
  assetId: ID,
  contentHash: createHash('sha256').update('x').digest('hex'),
  sourceAsset: KEY,
  correlationId: CORR,
});

/* ---------------- 契约常量一致性 / Constant parity ---------------- */

test('CONTRACT 与磁盘 JSON 一致；公开/禁止字段与前端常量逐字一致', () => {
  assert.deepEqual(CONTRACT, raw);
  assert.deepEqual([...PUBLIC_FIELDS].sort(), [...raw.publicFields].sort());
  assert.deepEqual([...FORBIDDEN_FIELDS].sort(), [...raw.forbiddenFields].sort());
  assert.deepEqual([...PUBLIC_FIELDS].sort(), [...WEB_PUBLIC].sort());
  assert.deepEqual([...FORBIDDEN_FIELDS].sort(), [...WEB_FORBIDDEN].sort());
  assert.deepEqual([...OBSERVABILITY_FORBIDDEN_FIELDS].sort(),
    [...raw.observability.forbiddenFields].sort());
  for (const field of raw.observability.forbiddenFields) {
    assert.ok(FORBIDDEN_FIELDS.includes(field), `observability 禁止字段 ${field} 应在总表内`);
  }
});

test('correlationId 契约：格式、header、sources、propagation、生成与校验', () => {
  assert.equal(CORRELATION_ID_HEADER, 'X-Correlation-Id');
  assert.equal(CORRELATION_ID_FORMAT, 'corr_[0-9a-f]{16}');
  assert.deepEqual(raw.correlationId.sources,
    ['client header if format-valid', 'server-generated otherwise']);
  for (const hop of ['auth /upload-url', 'processor -> recognition queue attribute',
    'recognition -> index publish']) {
    assert.ok(CORRELATION_PROPAGATION.includes(hop), `缺少传播点 ${hop}`);
  }
  assert.match(generateCorrelationId(), CORRELATION_ID_PATTERN);
  assert.equal(generateCorrelationId(() => Buffer.from('0123456789abcdef', 'hex')), CORR);
  for (const bad of ['', 'corr_XYZ', 'CORR_0123456789abcdef', 'corr_0123456789abcde',
    'corr_0123456789abcdef0', 123, null]) {
    assert.equal(isValidCorrelationId(bad), false, `${bad}`);
  }
  assert.equal(resolveCorrelationId(CORR), CORR);
  assert.match(resolveCorrelationId('bad'), CORRELATION_ID_PATTERN);
});

test('structuredLogEvent 契约：必填/可选/stages 与 observability.requiredFields 对齐', () => {
  assert.deepEqual(STRUCTURED_LOG_REQUIRED, raw.structuredLogEvent.required);
  assert.deepEqual(STRUCTURED_LOG_OPTIONAL, raw.structuredLogEvent.optional);
  assert.deepEqual(LOG_STAGES, raw.structuredLogEvent.stages);
  assert.deepEqual(raw.observability.requiredFields.slice(0, 5), STRUCTURED_LOG_REQUIRED);
  assert.ok(LOG_STAGES.includes('recognition') && LOG_STAGES.includes('index'));
});

test('结构化日志必填齐全、过滤 forbiddenFields、object key 只用安全摘要', () => {
  const event = buildLogEvent({
    event: 'recognition.completed', correlationId: CORR, stage: 'recognition',
    outcome: 'success', durationMs: 12, provider: 'fixture', attempt: 1,
    objectKeyDigest: safeObjectKeyDigest(KEY),
    phone: 'leak', token: 'leak', authorization: 'leak', rawModelResponse: {},
    nested: { secret: 'leak', originalUrl: 'leak' },
  });
  for (const key of STRUCTURED_LOG_REQUIRED) assert.ok(key in event, `缺 ${key}`);
  for (const key of raw.observability.requiredFields) assert.ok(key in event, `缺 ${key}`);
  for (const key of raw.observability.forbiddenFields) {
    assert.ok(!JSON.stringify(event).includes(`"${key}"`), `日志出现禁止字段 ${key}`);
  }
  assert.equal(event.objectKeyDigest, safeObjectKeyDigest(KEY));
  assert.equal(event.objectKeyDigest.length, 16);
  assert.ok(!JSON.stringify(event).includes(KEY), '日志不含对象 key 明文');
  assert.throws(() => buildLogEvent({ event: 'x', stage: 'recognition', outcome: 'success' }),
    /missing required|缺少必填/);
  assert.throws(() => buildLogEvent({
    event: 'x', correlationId: CORR, stage: 'bogus', outcome: 'success',
  }), /stage/);
  const dirty = { id: 'a', nested: { gps: 'leak', list: [{ token: 'leak' }] } };
  assert.deepEqual(findForbidden(stripForbidden(dirty)), []);
  assert.ok(findForbidden(dirty).length >= 2);
});

/* ---------------- 事件与查询 schema / Event and query schemas ---------------- */

test('recognition event 三种状态都符合契约 schema（含 additionalProperties:false）', () => {
  for (const status of ['success', 'failed', 'skipped']) {
    const event = buildRecognitionEvent({
      input,
      correlationId: CORR,
      status,
      labels: status === 'success'
        ? [{ term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.9 }] : [],
      errorClass: status === 'failed' ? 'provider-throttled' : null,
      provider: status === 'success' ? 'fixture' : null,
      occurredAt: '2026-11-13T00:00:00.000Z',
    });
    assertValid(event, raw.recognition.event);
    assert.equal(event.event, 'recognition.completed');
    assert.ok(raw.recognition.event.properties.status.enum.includes(event.status));
    assert.ok(new RegExp(raw.recognition.event.properties.sourceAsset.pattern).test(event.sourceAsset));
    for (const label of event.labels) {
      assert.deepEqual(Object.keys(label).sort(), ['category', 'confidence', 'name']);
    }
  }
});

test('八个示例的 toQuery 都符合契约 search.query', () => {
  for (const example of raw.queryContract.examples) {
    assertValid(toQuery(parseQuery(example), example), raw.search.query);
  }
  assert.throws(() => assertValid({ query: 'x', page: 0, pageSize: 40 }, raw.search.query));
  assert.throws(() => assertValid({ query: 'x', page: 1, pageSize: 40, extra: 1 }, raw.search.query));
});

test('search 结果符合契约 search.result，且只含 publicFields', () => {
  const manifest = defaultManifest();
  const items = [...defaultLabels().entries()].map(([id, labels]) => ({
    id, labels,
    colors: labels.filter((l) => l.kind === 'color').map((l) => l.term),
    source: 'rekognition',
  }));
  const index = createIndex({ manifest, items });
  const result = search(index, parseQuery('2025 年的蓝天和汽车'), manifest);
  assertValid(result, raw.search.result);
  for (const item of result.items) {
    for (const key of Object.keys(item)) assert.ok(PUBLIC_FIELDS.includes(key));
    assert.ok(item.score >= 0 && item.score <= 1);
    assert.ok(manifest.photos.some((photo) => photo.id === item.id));
  }
  assert.deepEqual(findForbidden(result), []);
  const projected = projectPublic(manifest.photos[0], { score: 0.5, explanation: [] });
  for (const key of Object.keys(projected)) assert.ok(PUBLIC_FIELDS.includes(key));
});

/* ---------------- 查询契约、索引契约、写路径归属 ---------------- */

test('queryContract：examples / parseResult 形状 / ranking / fallback', () => {
  for (const example of raw.queryContract.examples) {
    const parse = parseQuery(example);
    assert.deepEqual(Object.keys(parse).sort(),
      ['explanation', 'filters', 'page', 'pageSize', 'terms']);
    assert.deepEqual(Object.keys(parse.filters).sort(), ['colors', 'month', 'tags', 'year']);
  }
  assert.equal(RANKING, raw.queryContract.ranking);
  assert.equal(raw.queryContract.fallback,
    'manifest-only filtering when the index is unavailable');
  assert.equal(INDEX_VERSION, raw.version);
});

test('searchIndex 契约：shape 约束、s3PrefixOwnership、iamBoundaries', () => {
  assert.equal(raw.searchIndex.objectKeyPattern, 'data/search-index.<rev>.json');
  assert.equal(raw.searchIndex.shape.version, raw.version);
  assert.ok(raw.searchIndex.constraints.some((c) => c.includes('must exist in the active manifest')));
  assert.ok(raw.searchIndex.constraints.some((c) => c.includes('single float')));
  assert.ok(raw.searchIndex.constraints.some((c) => c.includes('duplicate id')));
  const owned = raw.s3PrefixOwnership['data/search-index.<rev>.json'];
  assert.equal(owned.writer, SEARCH_INDEX_OWNER);
  assert.equal(owned.canDelete, false);
  assert.equal(ownership().writer, owned.writer);
  assert.equal(ownership().canDelete, owned.canDelete);
  assert.match(raw.iamBoundaries['album-search-recognition'], /rekognition:DetectLabels/);
  assert.match(raw.iamBoundaries['album-search-recognition'], /grid\.webp/);
  assert.match(raw.iamBoundaries['album-search-publisher'], /data\/search-index/);
  for (const forbidden of raw.iamBoundaries.forbidden) {
    assert.equal(typeof forbidden, 'string');
  }
});

test('发布产物符合 searchIndex.shape：id 在 manifest、无重复、置信度单 float', async () => {
  const slice = await runVerticalSlice();
  const body = JSON.parse(slice.writer.puts[0].body);
  assert.equal(body.version, raw.version);
  assert.match(body.rev, /^[0-9a-f]{64}$/);
  assert.equal(body.rev, computeRev(slice.index));
  assert.equal(typeof body.vocabulary, 'object');
  const ids = new Set(slice.manifest.photos.map((photo) => photo.id));
  assert.equal(new Set(body.items.map((item) => item.id)).size, body.items.length, '无重复 id');
  for (const item of body.items) {
    assert.ok(ids.has(item.id), 'id 必须存在于 manifest');
    assert.ok(SOURCES.includes(item.source));
    for (const key of Object.keys(item)) assert.ok(ITEM_FIELDS.includes(key));
    for (const label of item.labels) {
      assert.equal(typeof label.confidence, 'number', '置信度是单个 float');
      assert.ok(label.confidence >= 0 && label.confidence <= 1);
    }
  }
  assert.deepEqual(findForbidden(body), []);
  const text = JSON.stringify(body);
  for (const field of raw.forbiddenFields) assert.ok(!text.includes(`"${field}"`), field);
  assert.ok(!text.includes('rawRekognitionResponse'));
  assert.ok(!text.includes('incoming/'), '产物不含原图前缀');
});

/* ---------------- 贯通与禁止字段扫描 / Propagation and scanning ---------------- */

test('correlation ID 贯通事件 → 日志 → 识别 → 发布；全产物禁止字段扫描', async () => {
  const slice = await runVerticalSlice();
  assert.match(slice.correlationId, CORRELATION_ID_PATTERN);
  assert.ok(slice.recognitionEvents.every((event) => event.correlationId === slice.correlationId));
  assert.ok(slice.logEvents.every((event) => event.correlationId === slice.correlationId));
  assert.equal(slice.published.correlationId, slice.correlationId);
  assert.equal(slice.loadedIndex.rev, slice.published.rev);
  assert.deepEqual(slice.forbiddenHits, []);
  assert.deepEqual(slice.rawLeaks, []);
  for (const object of [
    slice.index, slice.loadedIndex, ...slice.recognitionEvents, ...slice.logEvents,
    ...slice.results.map((entry) => entry.result),
  ]) {
    assert.deepEqual(findForbidden(object), []);
  }
  const text = JSON.stringify({
    index: slice.index, events: slice.recognitionEvents,
    logs: slice.logEvents, results: slice.results,
  });
  for (const field of raw.forbiddenFields) assert.ok(!text.includes(`"${field}"`), field);
  assert.ok(!text.includes('ResponseMetadata'), '不出现原始模型响应字段');
  // 识别输入只使用脱敏派生图
  for (const event of slice.recognitionEvents) {
    assert.ok(new RegExp(raw.recognition.event.properties.sourceAsset.pattern).test(event.sourceAsset));
    assert.ok(!event.sourceAsset.startsWith('incoming/'));
  }
});
