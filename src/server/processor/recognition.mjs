/**
 * 处理器内同步识别 + 索引发布（best-effort）/ In-processor sync recognition
 * plus index publishing (best-effort).
 *
 * 会话决策（spec/v5 plan.md 的 SQS 异步方案延后）：本期把识别做进 processor，
 * 识别失败绝不阻塞照片上线（FR-02、硬性不变量 2）。调用方（handler.mjs）
 * 必须把本模块的两个入口都包进 try/catch，失败只留结构化日志。
 *
 * Session decision (the SQS async design in spec/v5 plan.md is deferred):
 * recognition runs inside the processor for now and must never block
 * publication (FR-02, hard invariant 2). Callers (handler.mjs) wrap both
 * entry points in try/catch; failures leave structured logs only.
 *
 * 隐私边界 / Privacy:
 *   - 识别输入只能是脱敏派生图 photos/<id>/grid.webp（T-08），
 *     buildRecognitionInput 二次校验；原图永不进识别调用。
 *   - Rekognition 只接受 JPEG/PNG，不认 WebP —— grid.webp 先经 sharp 转成
 *     JPEG 字节，经 Image.Bytes 送检，不落盘、不经 S3Object。
 *   - 结果经 normalizeRekognitionResponse 归一化，raw 响应绝不进入产物或日志。
 *
 *   - Recognition input is the redacted derivative photos/<id>/grid.webp only
 *     (T-08, re-validated by buildRecognitionInput); originals never enter the
 *     recognition call.
 *   - Rekognition accepts JPEG/PNG only, not WebP — grid.webp is converted to
 *     JPEG bytes via sharp and sent via Image.Bytes; never written to disk and
 *     never referenced via S3Object.
 *   - Responses are normalized by normalizeRekognitionResponse; raw responses
 *     never enter artifacts or logs.
 *
 * 索引发布策略 / Index publishing:
 *   每次图片处理完成后全量重建 data/search-index.<rev>.json（rev = 内容
 *   sha256）+ data/search-index.json（前端兜底）。标签持久层是每图一个
 *   data/labels/<id>.json（不可变、无并发争抢）；重建时全量读取再按当前
 *   manifest 过滤，天然自愈 —— 并发上传时最后一个发布者看到的标签文件集
 *   已齐全，偶发的落后窗口会在下一次发布自动补齐。
 *
 *   Every processed image triggers a full rebuild of
 *   data/search-index.<rev>.json (rev = content sha256) plus
 *   data/search-index.json (frontend fallback). Labels persist as one
 *   data/labels/<id>.json per photo (immutable, no write contention); the
 *   rebuild reads them all and filters by the current manifest, so state is
 *   self-healing — a stale window after concurrent uploads closes on the next
 *   publish.
 *
 * 规模护栏 / Scale guard: 标签文件超过 LABEL_REBUILD_CAP 时跳过重建只写
 * 标签文件，防止 O(N) 读把 Lambda 拖爆（V6 换 SQS worker + 增量索引后移除）。
 * When label files exceed LABEL_REBUILD_CAP the rebuild is skipped (labels are
 * still written) so O(N) reads cannot blow the Lambda budget; remove once the
 * SQS worker + incremental index land in V6.
 */
import { createHash } from 'node:crypto';
import { env } from '../lib/config.mjs';
import { log } from '../lib/log.mjs';
import { backoffMs } from '../lib/retry.mjs';
import { buildRecognitionInput } from '../recognition/input.mjs';
import { normalizeLabels } from '../recognition/provider.mjs';
import { normalizeRekognitionResponse } from '../recognition/rekognition.mjs';
import { createIndex } from '../search/index.mjs';
import { computeRev, indexObjectKey } from '../search/publish.mjs';

/** 标签持久层前缀 / labels persistence prefix. */
export const LABELS_PREFIX = 'data/labels/';

/** 全量重建的标签文件数上限 / label-file cap for full rebuilds. */
export const LABEL_REBUILD_CAP = 2000;

/** DetectLabels 参数（与回填脚本一致）/ DetectLabels params (same as backfill). */
export const DETECT_PARAMS = {
  maxLabels: 30,
  minConfidence: 70,
  maxDominantColors: 10,
};

/** 识别开关：RECOGNITION_ENABLED=0 时只发布索引，不调用 Rekognition。 */
export function recognitionEnabled() {
  return env('RECOGNITION_ENABLED', '1') !== '0';
}

// sharp 与 store 都按需动态加载：单测是「零依赖安装」的（build-image.yml
// 直接跑 npm test，不装包），所以本模块在 import 时不能碰任何外部包。
// 生产环境（Lambda 镜像里有 sharp 与 AWS SDK）不受影响。
// sharp and store load lazily: unit tests run with zero installs
// (build-image.yml runs npm test without installing anything), so merely
// importing this module must not touch any external package. The Lambda
// image contains sharp and the AWS SDKs, so production is unaffected.
let defaultIoPromise = null;

async function defaultIo() {
  defaultIoPromise ??= import('./store.mjs').then((store) => ({ store }));
  return defaultIoPromise;
}

async function defaultConvertToJpeg(gridBuffer) {
  const { default: sharp } = await import('sharp');
  return sharp(gridBuffer).jpeg({ quality: 88 }).toBuffer();
}

// Rekognition SDK 按需动态加载：测试与未启用识别的环境完全不碰 AWS 包。
// The Rekognition SDK loads lazily: tests and disabled environments never
// touch the AWS package. Client is cached for the Lambda warm lifetime.
let rekognitionClientPromise = null;

async function defaultCallDetectLabels(params) {
  const { RekognitionClient, DetectLabelsCommand } = await import('@aws-sdk/client-rekognition');
  rekognitionClientPromise ??= Promise.resolve(new RekognitionClient({}));
  const client = await rekognitionClientPromise;
  return client.send(new DetectLabelsCommand(params));
}

/**
 * 带退避的 DetectLabels：只对 Throttling* 重试，其余错误直接抛给调用方。
 * DetectLabels with backoff: only Throttling* errors retry; everything else
 * propagates to the caller.
 */
export async function detectLabelsWithRetry(callDetectLabels, params, { attempts = 4, baseMs = 100 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await callDetectLabels(params);
    } catch (err) {
      const throttled = String(err?.name || '').includes('Throttl');
      if (!throttled || attempt >= attempts) throw err;
      await new Promise((resolve) => { setTimeout(resolve, backoffMs(attempt, baseMs)); });
    }
  }
}

function detectParams(jpegBuffer) {
  return {
    Image: { Bytes: jpegBuffer },
    MaxLabels: DETECT_PARAMS.maxLabels,
    MinConfidence: DETECT_PARAMS.minConfidence,
    Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES'],
    Settings: {
      GeneralLabels: { Blacklist: [] },
      ImageProperties: { MaxDominantColors: DETECT_PARAMS.maxDominantColors },
    },
  };
}

/**
 * 识别一张脱敏派生图。任何失败都向上抛（调用方兜底）；
 * 标签为空时返回 null（照片仍以 source=manifest 进索引）。
 *
 * Recognize one redacted derivative. Throws on failure (the caller contains
 * it); returns null when no labels survive (the photo still enters the index
 * as source=manifest).
 */
export async function recognizeGrid({
  assetId,
  gridBuffer,
  callDetectLabels = defaultCallDetectLabels,
  convertToJpeg = defaultConvertToJpeg,
} = {}) {
  if (!recognitionEnabled()) return null;
  if (!Buffer.isBuffer(gridBuffer) || gridBuffer.length === 0) {
    throw new TypeError('gridBuffer 必须是非空 Buffer / gridBuffer must be a non-empty Buffer');
  }

  // Rekognition 只认 JPEG/PNG / Rekognition accepts JPEG/PNG only
  const jpegBuffer = await convertToJpeg(gridBuffer);

  const contentHash = createHash('sha256').update(gridBuffer).digest('hex');
  const input = buildRecognitionInput({
    assetId,
    contentHash,
    sourceAsset: `photos/${assetId}/grid.webp`,
    correlationId: `corr_${contentHash.slice(0, 16)}`,
  });

  const raw = await detectLabelsWithRetry(callDetectLabels, detectParams(jpegBuffer));
  const labels = normalizeRekognitionResponse(raw);
  if (!labels.length) return null;
  return { labels, source: 'rekognition' };
}

/**
 * 纯函数：把标签条目转成索引 items（按 manifest 过滤、派生 colors）。
 * Pure: turn label entries into index items (manifest-filtered, colors derived).
 */
export function buildIndexItems({ manifest, labelEntries }) {
  const ids = new Set((manifest?.photos || []).map((photo) => photo?.id));
  return (Array.isArray(labelEntries) ? labelEntries : [])
    .filter((entry) => entry && typeof entry.id === 'string' && ids.has(entry.id)
      && Array.isArray(entry.labels) && entry.labels.length > 0)
    .map((entry) => ({
      id: entry.id,
      labels: normalizeLabels(entry.labels),
      colors: [...new Set(entry.labels
        .filter((label) => label?.kind === 'color')
        .map((label) => String(label.term)))],
      source: entry.source === 'manual' ? 'manual' : 'rekognition',
    }));
}

/**
 * 写标签文件（可注入 store，离线测试用内存替身）。
 * Write the per-photo labels file (injectable store; an in-memory double for
 * offline tests).
 */
async function writeLabelsFile(siteBucket, assetId, recognition, io) {
  const payload = {
    id: assetId,
    labels: recognition.labels,
    source: recognition.source || 'rekognition',
    updatedAt: new Date().toISOString(),
  };
  await io.store.putJson(siteBucket, `${LABELS_PREFIX}${assetId}.json`, payload, {
    cacheControl: io.store.CACHE_IMMUTABLE,
  });
  return payload;
}

/**
 * 全量重建并发布索引。可选先写标签文件；读 version.json → manifest →
 * data/labels/* → createIndex → 不可变 rev 版 + 前端兜底版。
 * recognition 为 null（识别失败/视频）时不写标签，但索引照常重建，
 * 让新照片以 source=manifest 条目入索引。
 * 返回 { rev, items, recognized }；任何失败向上抛（调用方兜底，
 * 照片上线不受影响）。
 *
 * Full index rebuild and publish, optionally writing the labels file first.
 * Reads version.json -> manifest -> data/labels/* -> createIndex -> immutable
 * rev object plus the frontend fallback object. A null recognition (failed
 * recognition or a video) skips the labels file but the index still rebuilds
 * so the new photo enters as a source=manifest entry.
 * Returns { rev, items, recognized }; throws on failure (the caller contains
 * it, publication is unaffected).
 */
export async function publishRecognition({
  siteBucket,
  assetId,
  recognition = null,
  io = null,
} = {}) {
  const { store: ioStore } = io || await defaultIo();
  if (recognition?.labels?.length && assetId) {
    await writeLabelsFile(siteBucket, assetId, recognition, { store: ioStore });
  }

  const versionKey = env('VERSION_KEY', 'data/version.json');
  const version = await ioStore.readJson(siteBucket, versionKey);
  const manifestKey = version?.manifest || env('MANIFEST_KEY', 'data/manifest.json');
  const manifest = await ioStore.readJson(siteBucket, manifestKey);
  if (!manifest?.photos?.length) {
    return { rev: null, items: 0, recognized: 0 };
  }

  const labelKeys = await ioStore.listKeys(siteBucket, LABELS_PREFIX);
  if (labelKeys.length > LABEL_REBUILD_CAP) {
    log.warn('index.rebuild_skipped_cap', { labelFiles: labelKeys.length, cap: LABEL_REBUILD_CAP });
    return { rev: null, items: 0, recognized: 0, skipped: 'cap' };
  }

  const labelEntries = [];
  for (const key of labelKeys) {
    const entry = await ioStore.readJson(siteBucket, key);
    if (entry?.id && Array.isArray(entry.labels)) labelEntries.push(entry);
  }

  const items = buildIndexItems({ manifest, labelEntries });
  const index = createIndex({ manifest, items });
  const rev = computeRev(index);
  const body = JSON.stringify({ version: index.version, rev, vocabulary: index.vocabulary || {}, items: index.items });

  // 不可变 rev 版：key 必须匹配发布器白名单；兜底版：no-store，前端降级取它
  // Immutable rev object: key must match the publisher whitelist; the fallback
  // object is no-store and is what the frontend degrades to.
  const versionedKey = indexObjectKey(rev);
  await ioStore.putBuffer(siteBucket, versionedKey, Buffer.from(body, 'utf8'), {
    contentType: 'application/json; charset=utf-8',
    cacheControl: ioStore.CACHE_IMMUTABLE,
  });
  await ioStore.putBuffer(siteBucket, 'data/search-index.json', Buffer.from(body, 'utf8'), {
    contentType: 'application/json; charset=utf-8',
    cacheControl: ioStore.CACHE_NO_STORE,
  });

  return { rev, items: index.items.length, recognized: items.length };
}
