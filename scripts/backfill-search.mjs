#!/usr/bin/env node
/**
 * 存量照片识别回填 + 搜索索引发布（一次性运维脚本）。
 * Backfill recognition for existing photos and publish the search index.
 *
 * 数据流 / Data flow:
 *   1. 读 version.json → 当前 manifest（唯一真相）；
 *   2. 读 data/search-labels.json（已识别标签的持久层，缺省为空）；
 *   3. 对每张缺标签的「图片」取脱敏派生图 photos/<id>/grid.webp（T-08：
 *      识别输入只能是脱敏静态图，视频本期不识别，仅时间/相册可筛）；
 *      Rekognition 只支持 JPEG/PNG，不认 WebP —— 本机用 sharp 把 webp
 *      解码转成 JPEG 字节，经 Image.Bytes 直接送 Rekognition（不经 S3）；
 *   4. Rekognition DetectLabels（GENERAL_LABELS + IMAGE_PROPERTIES 主色）
 *      → normalizeRekognitionResponse 归一化 → 写回 labels 文档；
 *   5. createIndex(manifest, items) → computeRev（64 hex）→ 发布
 *      data/search-index.<rev>.json（不可变）+ data/search-index.json
 *      （前端兜底路径，no-store）→ CloudFront 失效 /data/search-index*。
 *
 * 隐私边界 / Privacy: 只把脱敏派生图交给 Rekognition；标签是公开语义信息。
 * 本脚本只能由仓库主人本机执行（使用本机 IAM 凭证，非 Lambda 角色）。
 *
 * 用法 / Usage:
 *   node scripts/backfill-search.mjs [--bucket chenyouyi] [--distribution E2UWEFMOKOQEES]
 *       [--region ap-southeast-1] [--dry-run]
 */
import { createHash } from 'node:crypto';
import process from 'node:process';
import { RekognitionClient, DetectLabelsCommand } from '@aws-sdk/client-rekognition';
import sharp from 'sharp';

// store.mjs 的 S3Client({}) 依赖 AWS_REGION 解析区域，必须在 import 前设好。
// store's S3Client({}) resolves the region from AWS_REGION — set before import.
const REGION = process.env.AWS_REGION || 'ap-southeast-1';
process.env.AWS_REGION = REGION;

const { default: noop, ...store } = await import('../src/server/processor/store.mjs');
const { buildRecognitionInput } = await import('../src/server/recognition/input.mjs');
const { normalizeLabels } = await import('../src/server/recognition/provider.mjs');
const { normalizeRekognitionResponse } = await import('../src/server/recognition/rekognition.mjs');
const { createIndex, INDEX_VERSION } = await import('../src/server/search/index.mjs');
const { computeRev, indexObjectKey } = await import('../src/server/search/publish.mjs');

const LABELS_KEY = 'data/search-labels.json';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const bucket = arg('bucket', 'chenyouyi');
const distributionId = arg('distribution', 'E2UWEFMOKOQEES');
const dryRun = hasFlag('dry-run');
const concurrency = Number(arg('concurrency', '3'));

const rk = new RekognitionClient({ region: REGION });

/** 带节流重试的 DetectLabels（ Rekognition 偶发 ThrottlingException）。 */
async function detectLabels(params, attempt = 1) {
  try {
    return await rk.send(new DetectLabelsCommand(params));
  } catch (err) {
    const throttled = String(err?.name || '').includes('Throttl');
    if (throttled && attempt <= 4) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      return detectLabels(params, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  // 1) 当前 manifest
  const version = await store.readJson(bucket, 'data/version.json');
  if (!version?.manifest) throw new Error('version.json 缺 manifest 指针 / no manifest pointer');
  const manifest = await store.readJson(bucket, version.manifest);
  const photos = (manifest.photos || []).filter((p) => p?.type !== 'video');
  console.log(`manifest rev=${version.rev}，待识别图片=${photos.length}（视频不识别）`);

  // 2) 已有标签
  let labelsDoc = { version: INDEX_VERSION, labels: {} };
  try {
    const raw = await store.readJson(bucket, LABELS_KEY);
    if (raw?.labels) labelsDoc = raw;
  } catch { /* 首次运行为空 / first run starts empty */ }

  // 3) 逐张识别
  // Rekognition DetectLabels 仅支持 JPEG/PNG，不支持 WebP —— 所以本机先把
  // grid.webp 转成 JPEG buffer，用 Image.Bytes 送检（不再走 S3Object）。
  // Rekognition DetectLabels accepts JPEG/PNG only, not WebP — convert
  // grid.webp to a JPEG buffer locally and pass it via Image.Bytes.
  const provider = {
    async detectLabels(input, jpegBuffer) {
      const params = {
        Image: { Bytes: jpegBuffer },
        MaxLabels: 30,
        MinConfidence: 70,
        Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES'],
        Settings: {
          GeneralLabels: { Blacklist: [] },
          ImageProperties: { MaxDominantColors: 10 },
        },
      };
      const raw = await detectLabels(params);
      return normalizeRekognitionResponse(raw);
    },
  };

  // pending：无条目或条目里标签为空（上次 bug 留下的空条目也算待识别）
  // pending: missing entry OR empty labels (entries polluted by the earlier
  // bug are treated as pending, so the labels doc self-heals).
  const pending = photos.filter((p) => !(labelsDoc.labels[p.id]?.labels || []).length);
  console.log(`需要识别：${pending.length} 张 / to recognize: ${pending.length}`);
  let done = 0;
  let failed = 0;

  async function one(photo) {
    const key = `photos/${photo.id}/grid.webp`;
    try {
      const buffer = await store.getBuffer(bucket, key);
      const jpegBuffer = await sharp(buffer).jpeg({ quality: 88 }).toBuffer();
      const contentHash = createHash('sha256').update(buffer).digest('hex');
      const input = buildRecognitionInput({
        assetId: photo.id,
        contentHash,
        sourceAsset: key,
        correlationId: `corr_${createHash('sha256').update(contentHash).digest('hex').slice(0, 16)}`,
      });
      const raw = await provider.detectLabels(input, jpegBuffer);
      // normalizeRekognitionResponse 返回的已经是规范化标签数组
      // normalizeRekognitionResponse already returns the normalized label array
      labelsDoc.labels[photo.id] = { labels: normalizeLabels(raw), source: 'rekognition' };
      done += 1;
      if (done % 10 === 0 || done === pending.length) {
        console.log(`  进度 ${done}/${pending.length}`);
      }
    } catch (err) {
      failed += 1;
      console.warn(`  ✗ ${photo.id}: ${err?.name || ''} ${err?.message?.slice(0, 120) || err}`);
    }
  }

  async function pool(items, size, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await fn(next);
      }
    }));
  }

  if (!dryRun && pending.length) {
    await pool(pending, concurrency, one);
    await store.putJson(bucket, LABELS_KEY, labelsDoc, { cacheControl: store.CACHE_NO_STORE });
    console.log(`labels 文档已写：成功 ${done}，失败 ${failed}`);
  } else if (dryRun) {
    console.log(`dry-run：跳过识别（将处理 ${pending.length} 张）`);
  }

  // 5) 构建并发布索引（识别失败的照片自动落 source=manifest）
  const items = Object.entries(labelsDoc.labels)
    .filter(([id]) => photos.some((p) => p.id === id))
    .map(([id, value]) => ({
      id,
      labels: value.labels || [],
      colors: (value.labels || []).filter((l) => l.kind === 'color').map((l) => l.term),
      source: value.source || 'rekognition',
    }));
  const index = createIndex({ manifest, items });
  const rev = computeRev(index);
  const versionedKey = indexObjectKey(rev);
  const withRev = { ...index, rev };

  if (dryRun) {
    console.log(`dry-run：将发布 ${versionedKey} 与 data/search-index.json`);
    return;
  }

  await store.putJson(bucket, versionedKey, withRev, { cacheControl: store.CACHE_IMMUTABLE });
  await store.putJson(bucket, 'data/search-index.json', withRev, { cacheControl: store.CACHE_NO_STORE });

  try {
    await store.invalidate(distributionId, ['/data/search-index*']);
  } catch (err) {
    console.warn(`失效失败（不影响正确性，只是边缘节点多缓存一会儿）：${err?.message?.slice(0, 100)}`);
  }

  const recognized = items.filter((item) => item.source === 'rekognition' && item.labels.length).length;
  console.log(`✓ 索引已发布 rev=${rev.slice(0, 12)}：${index.items.length} 条，其中识别 ${recognized} 张`);
}

main().catch((err) => {
  console.error('回填失败 / backfill failed:', err?.message || err);
  process.exit(1);
});
