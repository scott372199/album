/**
 * V5 服务端 vertical slice：脱敏派生图 → 识别 → 索引 → 查询 → manifest-safe 结果。
 * V5 server vertical slice: redacted derivative -> recognition -> index ->
 * query -> manifest-safe results.
 *
 * 全链路可离线运行：Rekognition client、SQS、S3 writer、logger 全部注入 fake，
 * 不连 AWS、不新增 npm 依赖（契约 D-2 / D-5）。
 *
 * Fully offline: the Rekognition client, SQS, S3 writer and logger are all
 * injected fakes. No AWS calls and no new npm dependencies (D-2 / D-5).
 */
import { createHash } from 'node:crypto';
import {
  CONTRACT, createMemoryLogger, findForbidden, PUBLIC_FIELDS,
} from '../v5/correlation.mjs';
import {
  createWorker, createMemoryQueue, createInMemoryDedupe,
} from '../recognition/worker.mjs';
import { createFixtureProvider } from '../recognition/rekognition.mjs';
import { RAW_RESPONSE_KEYS } from '../recognition/provider.mjs';
import { zhForTerm } from './vocabulary.mjs';
import { parseQuery } from './query.mjs';
import { createIndex, INDEX_VERSION } from './index.mjs';
import { publishIndex, createMemoryWriter, latestIndex } from './publish.mjs';
import { runSearch } from './fallback.mjs';

const PHOTO_IDS = ['a1b2c3d4e5f6', 'b2c3d4e5f6a7', 'c3d4e5f6a7b8', 'd4e5f6a7b8c9'];

function label(term, confidence, kind) {
  return { term, zh: zhForTerm(term), kind, confidence };
}

/** 默认 manifest：字段与 v4 buildManifest 完全一致，只用占位 id 与相对路径。 */
export function defaultManifest() {
  const rows = [
    ['a1b2c3d4e5f6', 2025, 7, ['2025', '蓝天', '汽车']],
    ['b2c3d4e5f6a7', 2025, 7, ['2025', '湖水', '山峰']],
    ['c3d4e5f6a7b8', 2024, 3, ['2024', '摩托车', '红色衬衫']],
    ['d4e5f6a7b8c9', 2025, 11, ['2025', '衬衫', '红色']],
  ];
  return {
    site: { title: '个人相册', subtitle: '' },
    wall: {},
    story: {},
    hero: '',
    heroSections: [],
    photos: rows.map(([id, year, month, tags]) => ({
      id,
      type: 'image',
      album: String(year),
      year,
      month,
      tags,
      title: '',
      caption: '',
      ratio: 1.5,
      lqip: 'data:image/webp;base64,AAAA',
      featured: false,
      thumb: `photos/${id}/thumb.webp`,
      grid: `photos/${id}/grid.webp`,
      view: `photos/${id}/view.webp`,
    })),
    albums: [],
  };
}

/** fixture 识别结果：让六个示例查询都能命中 / covers all six sample queries. */
export function defaultLabels() {
  return new Map([
    ['a1b2c3d4e5f6', [label('blue sky', 0.95, 'scene'), label('car', 0.88, 'object')]],
    ['b2c3d4e5f6a7', [label('lake', 0.92, 'scene'), label('mountain', 0.85, 'scene')]],
    ['c3d4e5f6a7b8', [
      label('motorcycle', 0.9, 'object'), label('shirt', 0.8, 'object'),
      label('red', 0.75, 'color'),
    ]],
    ['d4e5f6a7b8c9', [label('shirt', 0.82, 'object'), label('red', 0.7, 'color')]],
  ]);
}

/** 脱敏派生图事件：sourceAsset 只可能是 photos/<12hex>/grid.webp。 */
export function defaultEvents({ correlationId } = {}) {
  return PHOTO_IDS.map((id, index) => ({
    body: JSON.stringify({
      assetId: id,
      contentHash: sha256(id),
      sourceAsset: `photos/${id}/grid.webp`,
      correlationId,
    }),
    receiptHandle: `rh-${index}`,
    attempt: 1,
  }));
}

export function defaultQueries() {
  return [...CONTRACT.queryContract.examples];
}

/** recognition event 的 {name,category,confidence} → 索引 labels 的 4 字段。 */
function itemsFromRecognitionEvents(events, manifest) {
  const ids = new Set(manifest.photos.map((photo) => photo.id));
  const byId = new Map();
  for (const event of events) {
    if (event.status !== 'success' || !ids.has(event.assetId)) continue;
    const labels = (event.labels || []).map((entry) => ({
      term: entry.name,
      zh: zhForTerm(entry.name),
      kind: entry.category,
      confidence: entry.confidence,
    }));
    byId.set(event.assetId, {
      id: event.assetId,
      labels,
      colors: labels.filter((entry) => entry.kind === 'color').map((entry) => entry.term),
      source: 'rekognition',
    });
  }
  return [...byId.values()];
}

function scanForbidden(objects) {
  const hits = [];
  for (const object of objects) {
    for (const path of findForbidden(object)) hits.push(path);
  }
  return hits;
}

/**
 * 跑整条链路。所有依赖可注入；indexAvailable=false 模拟索引不可用降级。
 *
 * Run the whole slice with injectable dependencies. indexAvailable=false
 * simulates an unavailable index and exercises the fallback path.
 */
export async function runVerticalSlice({
  manifest = defaultManifest(),
  events = null,
  queries = defaultQueries(),
  labelsByAsset = defaultLabels(),
  failAssets = new Set(),
  provider = null,
  correlationId = 'corr_0123456789abcdef',
  indexAvailable = true,
  logger = null,
} = {}) {
  const activeLogger = logger || createMemoryLogger();
  // 确定性时钟：每次调用递增，让 durationMs 为正且可复现
  // Deterministic clock: increments per call so durationMs is positive.
  let tick = 1700000000000;
  const clock = { now: () => (tick += 10) };
  const messages = events || defaultEvents({ correlationId });
  const queue = createMemoryQueue(messages);
  const callLog = [];
  const activeProvider = provider || createFixtureProvider({
    labelsByAsset, failAssets, callLog,
  });

  const recognitionEvents = [];
  const worker = createWorker({
    queue,
    provider: activeProvider,
    dedupe: createInMemoryDedupe(),
    logger: activeLogger,
    clock,
    onOutcome: (event) => recognitionEvents.push(event),
  });
  const workerResults = await worker.run();

  // 成功事件 → 索引 labels；失败事件不产出条目，createIndex 会给它 source=manifest
  // Success events feed index labels; failed ones keep source=manifest entries.
  const recognized = itemsFromRecognitionEvents(recognitionEvents, manifest);
  const index = createIndex({ manifest, items: recognized });

  const writer = createMemoryWriter();
  const published = indexAvailable
    ? await publishIndex({ index, manifest, writer, logger: activeLogger, correlationId })
    : null;
  const loadedIndex = indexAvailable ? latestIndex(writer) : null;
  const indexOptions = { version: INDEX_VERSION, rev: published?.rev || '' };

  const results = queries.map((query) => {
    const parse = parseQuery(query);
    return {
      query,
      parse,
      ...runSearch({ index: loadedIndex, parse, manifest, indexOptions, page: 1, pageSize: 40 }),
    };
  });

  const forbiddenHits = scanForbidden([
    index, loadedIndex, ...recognitionEvents, ...activeLogger.events,
    ...results.map((entry) => entry.result), published,
  ]);
  const asText = JSON.stringify({
    index, loadedIndex, recognitionEvents, logEvents: activeLogger.events, results,
  });
  const rawLeaks = RAW_RESPONSE_KEYS.filter((key) => asText.includes(`"${key}"`));

  return {
    correlationId,
    manifest,
    index,
    loadedIndex,
    published,
    writer,
    queue,
    callLog,
    recognitionEvents,
    workerResults,
    logEvents: activeLogger.events,
    results,
    forbiddenHits,
    rawLeaks,
    publishedPhotoIds: index.items.map((item) => item.id),
    publicFields: [...PUBLIC_FIELDS],
  };
}

/** 供测试生成合法小写 sha256 / helper for valid lowercase sha256 fixtures. */
export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
