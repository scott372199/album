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
 *   ALBUM_SITE_BUCKET=<站点桶> ALBUM_DISTRIBUTION_ID=<分发ID> \
 *     node scripts/backfill-search.mjs [--region ap-southeast-1] [--dry-run]
 *   （桶名与分发 ID 也可用 --bucket / --distribution 覆盖）
 *
 * 重识别选项 / Re-recognition options:
 *   --min-labels <n>       标签数低于 n 的照片重新识别（默认 1 = 只补零标签）
 *                          T-04 验收要求每张 ≥10 个中文可搜词时用 --min-labels 10
 *   --min-confidence <n>   默认取生产的 DETECT_PARAMS.minConfidence（70）
 *   --max-labels <n>       默认取生产的 DETECT_PARAMS.maxLabels（30）
 *   --escalate             对未达 --min-labels 的照片逐级降档，达标即停
 *   --escalate-floor <n>   降档下限（默认 55）。再往下会混进明显误标。
 *
 * 安全性质 / Safety:
 *   - 识别参数与生产 processor 同源（DETECT_PARAMS），不会出现「回填产物比线上稀」；
 *   - 变差就不覆盖：重识别结果标签更少时保留原值，可重复执行（幂等）；
 *   - --dry-run 不写任何对象、不发布索引、不失效 CloudFront。
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import process from 'node:process';

/**
 * AWS SDK 与 sharp 声明在 `src/server/package.json`，装在 `src/server/node_modules`。
 * 本脚本位于 `scripts/`，Node 的 ESM 解析只会向上找 `scripts/../node_modules`，
 * 找不到服务端那份——直接 `import '@aws-sdk/client-rekognition'` 在任何干净
 * checkout 上都会 ERR_MODULE_NOT_FOUND（已实测）。
 *
 * 所以按 server 包的位置解析，依赖留在它该在的地方，不污染根 package.json。
 * 前置：`npm --prefix src/server install --no-save`
 * （务必带 --no-save：不带的话 npm 会把根包以 `file:../..` 混进 server 依赖清单）
 *
 * The SDK lives in src/server/package.json. Resolve from there instead of
 * hoisting ops-only dependencies into the root package. Use --no-save, or npm
 * injects the root package into the server manifest as `file:../..`.
 */
const requireFromServer = createRequire(new URL('../src/server/package.json', import.meta.url));
const { RekognitionClient, DetectLabelsCommand } = requireFromServer('@aws-sdk/client-rekognition');
// sharp 是 CJS 默认导出，require 出来就是函数本身，不要再解构 default。
// sharp's CJS export IS the function — do not destructure `default`.
const sharp = requireFromServer('sharp');

const { escalationThresholds } = await import('./lib/thresholds.mjs');

// store.mjs 的 S3Client({}) 依赖 AWS_REGION 解析区域，必须在 import 前设好。
// store's S3Client({}) resolves the region from AWS_REGION — set before import.
const REGION = process.env.AWS_REGION || 'ap-southeast-1';
process.env.AWS_REGION = REGION;

const { default: noop, ...store } = await import('../src/server/processor/store.mjs');
const { buildRecognitionInput } = await import('../src/server/recognition/input.mjs');
const { normalizeLabels } = await import('../src/server/recognition/provider.mjs');
const { normalizeRekognitionResponse } = await import('../src/server/recognition/rekognition.mjs');
const { DETECT_PARAMS } = await import('../src/server/processor/recognition.mjs');
const { createIndex, INDEX_VERSION } = await import('../src/server/search/index.mjs');
const { computeRev, indexObjectKey } = await import('../src/server/search/publish.mjs');

// 标签持久层必须与 processor/recognition.mjs 一致：一图一文件
// data/labels/<id>.json。首次回填写过的单文档 data/search-labels.json 仅作
// legacy 数据源，运行时自动迁移，迁移后不再读写。
// Labels persist one file per photo in data/labels/<id>.json, matching
// processor/recognition.mjs. The legacy single document is migrated once and
// then no longer read or written.
const LEGACY_LABELS_KEY = 'data/search-labels.json';
const LABELS_PREFIX = 'data/labels/';
const labelObjectKey = (id) => `${LABELS_PREFIX}${id}.json`;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const bucket = arg('bucket', process.env.ALBUM_SITE_BUCKET || '');
const distributionId = arg('distribution', process.env.ALBUM_DISTRIBUTION_ID || '');
if (!bucket || !distributionId) {
  console.error('缺少 ALBUM_SITE_BUCKET / ALBUM_DISTRIBUTION_ID（或 --bucket / --distribution）');
  process.exit(1);
}
const dryRun = hasFlag('dry-run');
const concurrency = Number(arg('concurrency', '3'));

/**
 * 重识别阈值：标签数低于 `--min-labels` 的照片会重新识别。
 *
 * 默认 1 = 只补「零标签」的，与旧行为一致。T-04 的验收要求每张照片中文可搜词
 * ≥10，实测有 2 张只有 8/9 个标签 —— 传 `--min-labels 10` 才会把它们纳入。
 *
 * `--min-confidence` 默认取生产的 DETECT_PARAMS（70），不要轻易下调：调低会
 * 用低置信度标签换取数量，属于质量取舍，需要单独决策。
 */
const minLabels = Math.max(0, Number(arg('min-labels', '1')) || 0);
const minConfidence = Number(arg('min-confidence', String(DETECT_PARAMS.minConfidence)));
const maxLabels = Number(arg('max-labels', String(DETECT_PARAMS.maxLabels)));

if (!Number.isFinite(minConfidence) || minConfidence < DETECT_PARAMS.minConfidence) {
  console.warn(
    `⚠️ min-confidence=${minConfidence} 低于生产默认 ${DETECT_PARAMS.minConfidence}：`
    + '会用低置信度标签换数量，产物质量与生产不一致。',
  );
}

/**
 * 逐级降档 / Threshold escalation.
 *
 * 同参数重跑不会让标签变多——Rekognition 对同一张图、同一阈值是确定的（实测：
 * 26bd0ba3fe9b 在 70 与 60 都是 8 个）。要让「标签太稀疏」的照片达标，只能降阈值。
 * 但一刀切下调会把所有照片都降档，且降到 40 会混进明显的误标
 * （triangle / star symbol / angry / fallen person）。
 *
 * 所以做成显式开关：只对未达 `--min-labels` 的照片，从生产阈值开始逐级降到
 * `--escalate-floor`，**一旦达标立即停止**。质量优先，数量只是结果。
 *
 * Re-running at the same threshold yields the same labels (Rekognition is
 * deterministic per image+threshold). Escalation only applies to photos that
 * miss `--min-labels`, steps down to `--escalate-floor`, and stops as soon as
 * the target is met.
 */
const escalate = hasFlag('escalate');
const escalateFloor = Math.min(
  minConfidence,
  Number(arg('escalate-floor', '55')) || 55,
);
const STEP = 5;
const thresholds = escalate
  ? escalationThresholds(minConfidence, escalateFloor, STEP)
  : [];

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

  // 2) 已有标签：枚举按图文件；legacy 单文档自动迁移（幂等，已有条目优先）
  // 2) Existing labels: enumerate per-photo files; migrate the legacy single
  //    document once (idempotent — an existing per-photo file always wins).
  const labelsDoc = { version: INDEX_VERSION, labels: {} };
  let migrated = 0;
  for (const key of await store.listKeys(bucket, LABELS_PREFIX)) {
    const entry = await store.readJson(bucket, key);
    if (entry?.id && Array.isArray(entry.labels) && entry.labels.length) {
      labelsDoc.labels[entry.id] = {
        labels: entry.labels,
        source: entry.source || 'rekognition',
      };
    }
  }
  try {
    const legacy = await store.readJson(bucket, LEGACY_LABELS_KEY);
    for (const [id, value] of Object.entries(legacy?.labels || {})) {
      if (labelsDoc.labels[id]?.labels?.length
        || !Array.isArray(value?.labels) || !value.labels.length) continue;
      const source = value.source || 'rekognition';
      labelsDoc.labels[id] = { labels: value.labels, source };
      if (!dryRun) {
        await store.putJson(bucket, labelObjectKey(id), {
          id,
          labels: value.labels,
          source,
          updatedAt: new Date().toISOString(),
          migratedFrom: LEGACY_LABELS_KEY,
        }, { cacheControl: store.CACHE_IMMUTABLE });
      }
      migrated += 1;
    }
  } catch { /* 无 legacy 文档时忽略 / no legacy document is fine */ }
  if (migrated) {
    console.log(`legacy 标签迁移：${migrated} 张 → ${LABELS_PREFIX}<id>.json`);
  }

  // 3) 逐张识别
  // Rekognition DetectLabels 仅支持 JPEG/PNG，不支持 WebP —— 所以本机先把
  // grid.webp 转成 JPEG buffer，用 Image.Bytes 送检（不再走 S3Object）。
  // Rekognition DetectLabels accepts JPEG/PNG only, not WebP — convert
  // grid.webp to a JPEG buffer locally and pass it via Image.Bytes.
  const provider = {
    async detectLabels(input, jpegBuffer, threshold = minConfidence) {
      // 参数必须与生产 processor 完全一致，否则回填出来的标签密度与线上不一致。
      // 旧版这里写死了 MaxLabels/MinConfidence，漏了 MaxLabels 时会退回 AWS 默认值 10，
      // 于是回填出来的照片标签明显少于线上识别的照片。
      // Params must match the production processor exactly; the previous literal
      // omitted MaxLabels, which silently fell back to the AWS default of 10.
      const params = {
        Image: { Bytes: jpegBuffer },
        MaxLabels: maxLabels,
        MinConfidence: threshold,
        Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES'],
        Settings: {
          GeneralLabels: { Blacklist: [] },
          ImageProperties: { MaxDominantColors: DETECT_PARAMS.maxDominantColors },
        },
      };
      const raw = await detectLabels(params);
      return normalizeRekognitionResponse(raw);
    },
  };

  // pending：标签数低于 --min-labels 的照片。
  //   min-labels=1（默认）→ 无条目 / 空标签（旧 bug 留下的空条目也自愈）
  //   min-labels=10 → 连「标签太稀疏」的一起重识别
  // pending: photos whose label count is below --min-labels.
  const pending = photos.filter(
    (p) => (labelsDoc.labels[p.id]?.labels || []).length < minLabels,
  );
  const zeroLabel = pending.filter((p) => !(labelsDoc.labels[p.id]?.labels || []).length).length;
  console.log(`需要识别：${pending.length} 张 / to recognize: ${pending.length}`
    + `（其中零标签 ${zeroLabel} 张，稀疏 ${pending.length - zeroLabel} 张）`);
  console.log(`识别参数：MaxLabels=${maxLabels} MinConfidence=${minConfidence}`
    + `（生产 DETECT_PARAMS：${DETECT_PARAMS.maxLabels}/${DETECT_PARAMS.minConfidence}）`);
  if (escalate) {
    console.log(`逐级降档：必要时按 ${thresholds.join(' → ')} 依次尝试，达标（≥${minLabels}）即停`);
  }
  if (dryRun && pending.length) {
    for (const p of pending) {
      const n = (labelsDoc.labels[p.id]?.labels || []).length;
      console.log(`  · ${p.id}  当前 ${n} 个标签 → 将重识别`);
    }
  }
  let done = 0;
  let failed = 0;
  let kept = 0;

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
      // 逐级降档：达标即停，避免为一两张照片把所有结果都降到低置信度。
      // 不开启 escalate 时只在生产阈值上跑一次，行为与旧版一致。
      const tries = escalate ? thresholds : [minConfidence];
      let labels = [];
      let used = minConfidence;
      for (const threshold of tries) {
        const raw = await provider.detectLabels(input, jpegBuffer, threshold);
        // normalizeRekognitionResponse 返回的已经是规范化标签数组
        // normalizeRekognitionResponse already returns the normalized label array
        labels = normalizeLabels(raw);
        used = threshold;
        if (!escalate || labels.length >= minLabels) break;
      }
      if (escalate && used !== minConfidence) {
        console.log(`  ↳ ${photo.id}: 降到 MinConfidence=${used} 才达标（${labels.length} 个标签）`);
      }

      // 变差就不覆盖：重识别只应改善，不该因为偶发波动把已有标签变少。
      // 这条让「重跑一次」变成幂等安全操作 —— 结果不更好就保持原样并计数。
      // Keep-if-worse: a re-run must never reduce a photo's labels. This makes
      // re-running the script idempotent and safe.
      const previous = labelsDoc.labels[photo.id]?.labels || [];
      if (previous.length && labels.length < previous.length) {
        kept += 1;
        console.log(`  - ${photo.id}: 重识别得到 ${labels.length} 个，少于原有 ${previous.length} 个，保留原值`);
        done += 1;
        return;
      }

      if (!dryRun) {
        await store.putJson(bucket, labelObjectKey(photo.id), {
          id: photo.id,
          labels,
          source: 'rekognition',
          updatedAt: new Date().toISOString(),
        }, { cacheControl: store.CACHE_IMMUTABLE });
      }
      labelsDoc.labels[photo.id] = { labels, source: 'rekognition' };
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
    console.log(`标签文件已写：成功 ${done}，失败 ${failed}，保留原值 ${kept}`);
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
