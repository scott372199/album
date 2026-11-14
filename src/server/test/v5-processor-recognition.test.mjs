import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  recognitionEnabled, recognizeGrid, detectLabelsWithRetry,
  buildIndexItems, publishRecognition, LABELS_PREFIX, LABEL_REBUILD_CAP,
} from '../processor/recognition.mjs';
import { createMemoryLogger } from '../v5/correlation.mjs';

/**
 * 处理器内识别与索引发布测试：全离线，不 import AWS SDK。
 * - recognizeGrid 用注入 fake + 真 sharp 转码（webp→JPEG 字节）；
 * - publishRecognition 用内存 store 替身验证「标签文件 → 索引发布」；
 * - 识别失败/空标签不阻塞，照片仍以 source=manifest 进索引。
 *
 * In-processor recognition and index publish tests: fully offline, no AWS SDK
 * import. recognizeGrid uses an injected fake plus real sharp transcoding;
 * publishRecognition runs against an in-memory store double.
 */
const ID = 'abcdef012345';
const rekognitionSample = () => ({
  Labels: [
    { Name: 'Lake', Confidence: 92, Categories: [{ Name: 'Nature' }] },
    { Name: 'Car', Confidence: 81, Categories: [{ Name: 'Vehicles and Vehicles' }] },
  ],
  ImageProperties: {
    DominantColors: [
      { SimplifiedColor: 'Blue', PixelPercent: 40 },
    ],
  },
});

/* ---------------- 开关 / toggle ---------------- */

test('RECOGNITION_ENABLED=0 关闭识别，recognizeGrid 直接返回 null', async () => {
  const prev = process.env.RECOGNITION_ENABLED;
  process.env.RECOGNITION_ENABLED = '0';
  try {
    assert.equal(recognitionEnabled(), false);
    const result = await recognizeGrid({
      assetId: ID,
      gridBuffer: Buffer.from('anything'),
      callDetectLabels: async () => { throw new Error('不应调用 / must not be called'); },
    });
    assert.equal(result, null);
  } finally {
    if (prev === undefined) delete process.env.RECOGNITION_ENABLED;
    else process.env.RECOGNITION_ENABLED = prev;
  }
});

/* ---------------- recognizeGrid / recognition path ---------------- */

test('recognizeGrid 把 webp 转 JPEG 经 Bytes 送检，返回规范化标签', async () => {
  const sharp = (await import('sharp')).default;
  const grid = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).webp().toBuffer();

  const seen = [];
  const result = await recognizeGrid({
    assetId: ID,
    gridBuffer: grid,
    callDetectLabels: async (params) => {
      seen.push(params);
      return rekognitionSample();
    },
  });

  assert.equal(seen.length, 1);
  // Rekognition 只收 JPEG/PNG：送检字节必须是 JPEG magic
  // Rekognition accepts JPEG/PNG only: the bytes must carry the JPEG magic
  assert.deepEqual(
    [...seen[0].Image.Bytes.slice(0, 2)],
    [0xff, 0xd8],
  );
  assert.equal(seen[0].MaxLabels, 30);
  assert.deepEqual(seen[0].Features, ['GENERAL_LABELS', 'IMAGE_PROPERTIES']);

  assert.ok(result.source === 'rekognition');
  const terms = result.labels.map((label) => label.term);
  assert.ok(terms.includes('car'), 'Car 应映射进规范词 / Car must map to a canonical term');
  assert.ok(result.labels.some((label) => label.kind === 'color' && label.term === 'blue'),
    '主色应产出 color 标签 / dominant colors must yield color labels');
});

test('识别输入不可被调用方注入：sourceAsset 恒为 photos/<id>/grid.webp；空 buffer 拒绝', async () => {
  // recognizeGrid 的 sourceAsset 由 assetId 派生，调用方无法塞 incoming/ 原图
  // The caller cannot inject an incoming/ original — sourceAsset derives from assetId.
  const sharp = (await import('sharp')).default;
  const grid = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).webp().toBuffer();
  const seen = [];
  await recognizeGrid({
    assetId: ID,
    gridBuffer: grid,
    callDetectLabels: async (params) => { seen.push(params); return rekognitionSample(); },
  });
  assert.equal(seen.length, 1);

  await assert.rejects(
    recognizeGrid({ assetId: ID, gridBuffer: Buffer.alloc(0) }),
    /gridBuffer/,
  );
  await assert.rejects(
    recognizeGrid({ assetId: ID, gridBuffer: 'not-a-buffer' }),
    /gridBuffer/,
  );
});

/* ---------------- 重试 / retry ---------------- */

test('Throttling 按退避重试后成功，非节流错误不重试', async () => {
  let calls = 0;
  const throttling = await detectLabelsWithRetry(async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('rate exceeded');
      err.name = 'ThrottlingException';
      throw err;
    }
    return rekognitionSample();
  }, { Image: { Bytes: Buffer.alloc(1) } }, { baseMs: 1 });
  assert.equal(calls, 3);
  assert.ok(throttling.Labels.length);

  calls = 0;
  await assert.rejects(
    detectLabelsWithRetry(async () => {
      calls += 1;
      const err = new Error('bad request');
      err.name = 'ValidationException';
      throw err;
    }, { Image: { Bytes: Buffer.alloc(1) } }, { baseMs: 1 }),
    /bad request/,
  );
  assert.equal(calls, 1, '非节流错误必须立即抛出 / non-throttling errors must not retry');
});

/* ---------------- buildIndexItems / pure mapping ---------------- */

test('buildIndexItems 按 manifest 过滤并派生 colors', () => {
  const manifest = { photos: [{ id: ID, year: 2025, month: 6 }, { id: 'ffff00001111', year: 2025, month: 7 }] };
  const entries = [
    { id: ID, labels: [{ term: 'car', zh: '汽车', kind: 'object', confidence: 0.81 }, { term: 'red', zh: '红色', kind: 'color', confidence: 0.5 }], source: 'rekognition' },
    { id: 'ghost00000000', labels: [{ term: 'car', zh: '汽车', kind: 'object', confidence: 0.9 }] },
    { id: 'ffff00001111', labels: [] },
  ];
  const items = buildIndexItems({ manifest, labelEntries: entries });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, ID);
  assert.deepEqual(items[0].colors, ['red']);
  assert.equal(items[0].source, 'rekognition');
});

/* ---------------- publishRecognition / end-to-end offline ---------------- */

/** 内存 store 替身：putJson/putBuffer/readJson/listKeys / in-memory store double. */
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

const manifestFixture = () => ({
  photos: [
    { id: ID, type: 'image', year: 2025, month: 6, tags: ['album:family'] },
    { id: 'ffff00001111', type: 'video', year: 2025, month: 7, tags: [] },
  ],
});

function seedStore(objects) {
  const store = memoryStore();
  store.objects.set('data/version.json', Buffer.from(JSON.stringify({
    rev: 'a1b2c3d4e5f6', manifest: 'data/manifest.a1b2c3d4e5f6.json', counts: { images: 1, videos: 1 },
  })));
  store.objects.set('data/manifest.a1b2c3d4e5f6.json', Buffer.from(JSON.stringify(manifestFixture())));
  for (const [key, value] of Object.entries(objects)) {
    store.objects.set(key, Buffer.from(JSON.stringify(value)));
  }
  return store;
}

test('publishRecognition：识别成功 → 写标签文件 → 发布 rev 版与兜底版索引', async () => {
  const store = seedStore({
    [`${LABELS_PREFIX}older0000aaaa.json`]: {
      id: 'older0000aaaa',
      labels: [{ term: 'lake', zh: '湖水', kind: 'scene', confidence: 0.92 }],
      source: 'rekognition',
    },
  });
  // older0000aaaa 不在 manifest 里，应被过滤掉（自愈：脏标签不进索引）
  // older0000aaaa is absent from the manifest and must be filtered out.
  const result = await publishRecognition({
    siteBucket: 'site',
    assetId: ID,
    recognition: {
      labels: [{ term: 'car', zh: '汽车', kind: 'object', confidence: 0.81 }, { term: 'blue', zh: '蓝色', kind: 'color', confidence: 0.4 }],
      source: 'rekognition',
    },
    io: { store },
  });

  assert.ok(result.rev, '必须返回索引 rev / must return an index rev');
  assert.match(result.rev, /^[0-9a-f]{64}$/);
  assert.equal(result.items, 2, 'manifest 全部条目都在索引里 / every manifest photo is indexed');
  assert.equal(result.recognized, 1);

  // 标签文件已写 / the labels file was written
  assert.ok(store.objects.has(`${LABELS_PREFIX}${ID}.json`));

  // 不可变 rev 版 + 前端兜底版都已发布
  // The immutable rev object and the frontend fallback were both published.
  const fallback = JSON.parse(store.objects.get('data/search-index.json').toString('utf8'));
  assert.equal(fallback.rev, result.rev);
  assert.equal(fallback.version, fallback.version);
  const item = fallback.items.find((entry) => entry.id === ID);
  assert.ok(item.labels.some((label) => label.term === 'car'));
  assert.ok(item.labels.some((label) => label.kind === 'color' && label.term === 'blue'));
  assert.equal(item.source, 'rekognition');
  const video = fallback.items.find((entry) => entry.id === 'ffff00001111');
  assert.equal(video.source, 'manifest', '视频以 manifest 条目入索引 / videos enter as manifest entries');
});

test('publishRecognition：识别失败（null）不写标签，索引仍重建', async () => {
  const store = seedStore({});
  const result = await publishRecognition({
    siteBucket: 'site',
    assetId: ID,
    recognition: null,
    io: { store },
  });
  assert.ok(result.rev);
  assert.ok(!store.objects.has(`${LABELS_PREFIX}${ID}.json`));
  const fallback = JSON.parse(store.objects.get('data/search-index.json').toString('utf8'));
  const item = fallback.items.find((entry) => entry.id === ID);
  assert.equal(item.source, 'manifest', '识别失败的照片保留 manifest 条目 / failed recognition keeps a manifest entry');
});

test('publishRecognition：标签文件超过上限时跳过重建，不抛错', async () => {
  const objects = {};
  for (let i = 0; i < LABEL_REBUILD_CAP + 1; i += 1) {
    const id = String(i).padStart(12, '0');
    objects[`${LABELS_PREFIX}${id}.json`] = {
      id,
      labels: [{ term: 'car', zh: '汽车', kind: 'object', confidence: 0.8 }],
    };
  }
  const store = seedStore(objects);
  const result = await publishRecognition({
    siteBucket: 'site',
    assetId: ID,
    recognition: null,
    io: { store },
  });
  assert.equal(result.skipped, 'cap');
  assert.equal(result.rev, null);
});

test('结构化日志字段守卫：内存日志不含 raw 响应键', async () => {
  const logger = createMemoryLogger();
  logger.emit({
    event: 'process.recognition', outcome: 'recognized', stage: 'recognition',
    correlationId: 'corr_test', assetId: ID, provider: 'aws-rekognition', errorClass: null,
  });
  const forbidden = ['raw', 'rawResponse', 'Labels', 'ImageProperties', '$metadata'];
  for (const entry of logger.events) {
    for (const key of forbidden) assert.ok(!(key in entry));
  }
});
