import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runVerticalSlice, defaultManifest, defaultEvents, defaultLabels, sha256,
} from '../search/e2e.mjs';
import {
  CONTRACT, PUBLIC_FIELDS, FORBIDDEN_FIELDS, findForbidden,
} from '../v5/correlation.mjs';

/**
 * V5 vertical slice 端到端（全 fake、离线）：
 * 脱敏派生图 → 识别 → 索引 → 查询 → manifest-safe 结果。
 * 覆盖成功、重复、识别失败、索引不可用、原图拒绝与降级路径。
 *
 * End-to-end V5 vertical slice (all fakes, offline): redacted derivative ->
 * recognition -> index -> query -> manifest-safe results. Covers success,
 * duplicates, recognition failure, unavailable index, original rejection and
 * degradation.
 */
const CORR = 'corr_0123456789abcdef';

test('完整链路：脱敏派生图 → 识别 → 索引 → 查询 → manifest-safe 结果', async () => {
  const slice = await runVerticalSlice();
  assert.equal(slice.recognitionEvents.length, 4);
  assert.equal(slice.publishedPhotoIds.length, slice.manifest.photos.length);
  assert.match(slice.published.key, /^data\/search-index\.[0-9a-f]{64}\.json$/);
  assert.equal(slice.writer.puts.length, 1, '只写唯一索引前缀');
  assert.equal(slice.results.length, CONTRACT.queryContract.examples.length);
  for (const entry of slice.results) {
    assert.equal(entry.fromIndex, true);
    assert.equal(entry.degraded, false);
    assert.ok(Array.isArray(entry.explanation));
    for (const item of entry.result.items) {
      for (const key of Object.keys(item)) assert.ok(PUBLIC_FIELDS.includes(key));
      assert.ok(slice.manifest.photos.some((photo) => photo.id === item.id));
      assert.ok(item.score >= 0 && item.score <= 1);
      assert.ok(item.paths && typeof item.paths === 'object');
    }
  }
  // 所有识别输入都是已脱敏的派生图
  for (const event of slice.recognitionEvents) {
    assert.match(event.sourceAsset, /^photos\/[a-f0-9]{12}\/(grid|view)\.webp$/);
  }
});

test('六个示例查询都有可解释命中', async () => {
  const slice = await runVerticalSlice();
  for (const query of ['湖水', '山峰', '蓝天', '汽车', '摩托车', '红色衬衫']) {
    const entry = slice.results.find((result) => result.query === query);
    assert.ok(entry, `缺少查询 ${query}`);
    assert.ok(entry.result.total > 0, `${query} 应有命中`);
    assert.ok(entry.explanation.length > 0, `${query} 应可解释`);
  }
});

test('年份组合：2025 年 / 2025 年的蓝天和汽车只返回 2025 的公开条目', async () => {
  const slice = await runVerticalSlice();
  const yearOnly = slice.results.find((entry) => entry.query === '2025 年');
  assert.equal(yearOnly.parse.filters.year, 2025);
  assert.ok(yearOnly.result.total > 0);
  assert.ok(yearOnly.result.items.every((item) => item.year === 2025));

  const combo = slice.results.find((entry) => entry.query === '2025 年的蓝天和汽车');
  assert.equal(combo.parse.filters.year, 2025);
  assert.deepEqual(combo.parse.terms, ['blue sky', 'car']);
  assert.ok(combo.result.total > 0);
  assert.ok(combo.result.items.every((item) => item.year === 2025));
  assert.deepEqual(combo.explanation.map((e) => e.kind).slice(0, 1), ['year']);
});

test('重复事件幂等：provider 只调用一次，索引条目不重复', async () => {
  const base = defaultEvents({ correlationId: CORR });
  const events = [...base, base[0]];
  const slice = await runVerticalSlice({ events });
  assert.equal(slice.callLog.length, 4, '唯一资产数 = 识别调用次数');
  assert.equal(slice.recognitionEvents.filter((event) => event.status === 'success').length, 4);
  assert.ok(slice.workerResults.some((result) => result.outcome === 'duplicate'));
  assert.equal(new Set(slice.index.items.map((item) => item.id)).size, 4);
});

test('识别失败仍可发布：失败照片保留 source=manifest 条目，基础筛选可用', async () => {
  const failedId = 'a1b2c3d4e5f6';
  const slice = await runVerticalSlice({ failAssets: new Set([failedId]) });
  assert.ok(slice.published, '索引仍成功发布');
  assert.ok(slice.publishedPhotoIds.includes(failedId), '照片上线不受识别失败影响');
  const failedItem = slice.index.items.find((item) => item.id === failedId);
  assert.equal(failedItem.source, 'manifest');
  assert.deepEqual(failedItem.labels, []);
  assert.ok(slice.queue.dlq.length >= 1, '坏事件进 DLQ');
  assert.ok(slice.recognitionEvents.some((event) => event.status === 'failed'));
  const yearOnly = slice.results.find((entry) => entry.query === '2025 年');
  assert.ok(yearOnly.result.total > 0, '基础筛选仍可用');
});

test('索引不可用降级：只用 manifest 的年份/月份/标签，degraded 明确', async () => {
  const slice = await runVerticalSlice({ indexAvailable: false });
  assert.equal(slice.published, null);
  assert.equal(slice.loadedIndex, null);
  assert.ok(slice.results.every((entry) => entry.degraded === true && entry.fromIndex === false));
  const yearOnly = slice.results.find((entry) => entry.query === '2025 年');
  assert.ok(yearOnly.result.total >= 3);
  for (const item of yearOnly.result.items) {
    for (const key of Object.keys(item)) assert.ok(PUBLIC_FIELDS.includes(key));
    assert.ok(slice.manifest.photos.some((photo) => photo.id === item.id));
  }
});

test('原图拒绝：incoming/ 事件进 DLQ，不进入识别与索引', async () => {
  const original = {
    body: JSON.stringify({
      assetId: 'a1b2c3d4e5f6',
      contentHash: sha256('x'),
      sourceAsset: 'incoming/a.jpg',
      correlationId: CORR,
    }),
    receiptHandle: 'rh-original',
    attempt: 1,
  };
  const slice = await runVerticalSlice({
    events: [...defaultEvents({ correlationId: CORR }), original],
  });
  assert.ok(slice.queue.dlq.some((entry) => entry.errorClass === 'incoming-original-rejected'));
  assert.ok(!slice.recognitionEvents.some((event) => event.sourceAsset.startsWith('incoming/')));
  assert.equal(slice.index.items.length, 4);
  assert.deepEqual(slice.forbiddenHits, []);
});

test('禁止字段扫描：索引、日志、事件、结果、发布产物全部干净', async () => {
  const slice = await runVerticalSlice();
  assert.deepEqual(slice.forbiddenHits, []);
  assert.deepEqual(slice.rawLeaks, []);
  const objects = [
    slice.index,
    slice.loadedIndex,
    ...slice.recognitionEvents,
    ...slice.logEvents,
    ...slice.results.map((entry) => entry.result),
  ];
  for (const object of objects) assert.deepEqual(findForbidden(object), []);
  const text = JSON.stringify(objects);
  for (const field of FORBIDDEN_FIELDS) {
    assert.ok(!text.includes(`"${field}"`), `出现禁止字段 ${field}`);
  }
  assert.ok(!text.includes('rawRekognitionResponse'));
  assert.ok(!text.includes('ResponseMetadata'));
  assert.ok(!text.includes('incoming/'));
  assert.ok(!text.includes('originalFilename'));
});

test('correlation ID 贯通：事件 → 日志 → 识别 → 索引发布 → 结果', async () => {
  const correlationId = 'corr_feedbeefdeadbeef';
  const slice = await runVerticalSlice({ correlationId });
  assert.equal(slice.correlationId, correlationId);
  assert.ok(slice.logEvents.length > 0);
  assert.ok(slice.logEvents.every((event) => event.correlationId === correlationId));
  assert.ok(slice.recognitionEvents.every((event) => event.correlationId === correlationId));
  assert.equal(slice.published.correlationId, correlationId);
  assert.equal(slice.loadedIndex.rev, slice.published.rev);
  const publishedLog = slice.logEvents.find((event) => event.event === 'index.published');
  assert.ok(publishedLog);
  assert.equal(publishedLog.correlationId, correlationId);
  assert.equal(publishedLog.objectKeyDigest.length, 16);
  assert.ok(!JSON.stringify(publishedLog).includes(slice.published.key));
});

test('默认 fixture 自洽：labels 与 manifest id 一一对应', () => {
  const manifest = defaultManifest();
  const labels = defaultLabels();
  assert.equal(labels.size, manifest.photos.length);
  for (const photo of manifest.photos) {
    assert.ok(labels.has(photo.id), `缺少 ${photo.id} 的识别结果`);
    for (const label of labels.get(photo.id)) {
      assert.equal(typeof label.confidence, 'number');
      assert.ok(['object', 'scene', 'color'].includes(label.kind));
    }
  }
  assert.equal(sha256('x').length, 64);
});
