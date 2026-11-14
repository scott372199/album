import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../lib/config.mjs';
import { log, errorFields } from '../lib/log.mjs';
import { backoffMs } from '../lib/retry.mjs';
import * as store from './store.mjs';
import { processImage } from './image.mjs';
import { processVideo } from './video.mjs';
import {
  emptyManifest, normalizeManifest, upsertPhoto, countTypes,
} from './manifest.mjs';
import {
  sha256, decodeKey, decodeAlbum, kindOf, parseIso, resolveYearMonth, tagsFor,
} from './derive.mjs';
import { recognizeGrid, publishRecognition } from './recognition.mjs';

/**
 * 处理函数：源桶 `incoming/` 下的新对象 → 站点桶的产物 + 清单条目 → 删源图。
 *
 * 由 S3 事件触发（一条对象一个事件）。之所以敢「单条失败就抛错」，是因为
 * 整个流程是幂等的：产物同名覆盖、清单按 id upsert、删源图放在最后。
 * 重试的最大代价是重新转码一次，而不是数据错乱。
 *
 * Triggered by S3 events, one object per event. Throwing on failure is safe
 * because every step is idempotent: artifacts overwrite by name, the manifest
 * upserts by id, and the source delete comes last. The worst a retry costs is
 * one extra transcode, never corrupted state.
 */

const TMP_ROOT = '/tmp/album';

/**
 * 清单指针写冲突时最多重读几轮、每轮基础退避多少毫秒。
 * 并发上传一批 20 张，冲突轮数一般是个位数；5 轮 × 最慢 250ms 足够，
 * 又不至于把一个真正卡住的事件拖到超时。
 * Retry budget for pointer contention.
 */
const MANIFEST_ATTEMPTS = 5;
const MANIFEST_RETRY_MS = 50;

const ARTIFACT_TYPES = {
  'thumb.webp': 'image/webp',
  'grid.webp': 'image/webp',
  'view.webp': 'image/webp',
  'poster.webp': 'image/webp',
  'clip.mp4': 'video/mp4',
};

async function writeArtifacts(siteBucket, id, buffers) {
  for (const [name, body] of Object.entries(buffers)) {
    await store.putBuffer(siteBucket, `photos/${id}/${name}`, body, {
      contentType: ARTIFACT_TYPES[name] || 'application/octet-stream',
      cacheControl: store.CACHE_IMMUTABLE,
    });
  }
}

/**
 * 读取当前清单：先看 version.json 指向哪一份，再退到固定名。
 * 固定名是本地 `build:web` 的产物，线上首次部署时它就是当时的清单，
 * 于是「服务端第一次追加照片」不会把已有照片全部抹掉。
 */
/**
 * 读当前清单，连同指针文件自身的 ETag 一起返回——提交时要拿它做条件写。
 * 固定名是本地 `build:web` 的产物，线上首次部署时它就是当时的清单，
 * 于是「服务端第一次追加照片」不会把已有照片全部抹掉。
 *
 * Returns the manifest together with the pointer's ETag, which the commit step
 * needs for a conditional write.
 */
async function readVersionAndManifest(siteBucket) {
  const versionKey = env('VERSION_KEY', 'data/version.json');
  const manifestKey = env('MANIFEST_KEY', 'data/manifest.json');

  let version = null;
  try {
    version = await store.getJsonWithEtag(siteBucket, versionKey);
  } catch (err) {
    log.warn('manifest.version_unreadable', errorFields(err));
  }

  const pointers = [
    typeof version?.value?.manifest === 'string' ? version.value.manifest : '',
    manifestKey,
  ].filter(Boolean);

  for (const key of pointers) {
    const value = await store.readJson(siteBucket, key);
    if (value) return { version, manifest: normalizeManifest(value) };
  }
  return { version, manifest: emptyManifest() };
}

/**
 * 把一条记录并进清单，并推进指针。
 *
 * 并发上传时多个事件会同时跑：它们各自读到同一版清单，各自加一条，后写的
 * 会把先写的那条冲掉。原先靠「预留并发 = 1」把这里串起来，但新账号的总并发
 * 只有 50，AWS 不接受任何预留值（留 1 个就跌破非预留下限 50）。
 *
 * 所以改成条件写：指针文件带 `If-Match: <读到的 ETag>`，一旦有人抢先写过就
 * 返回 412，这边重读、重新合并、再写。代价是冲突时多做一轮，好处是不再
 * 依赖并发额度，也不会静默丢照片。
 *
 * Concurrent uploads each read the same manifest, add their own entry, and the
 * last writer wins — silently dropping the others. This used to be serialised
 * by a reserved concurrency of 1, but a new account is capped at 50 total and
 * AWS rejects any reservation against that. Conditional writes replace it: the
 * pointer carries `If-Match: <etag>`, a loser gets 412, and it re-reads, re-merges
 * and retries.
 */
async function commitManifest(siteBucket, record) {
  const versionKey = env('VERSION_KEY', 'data/version.json');

  for (let attempt = 1; attempt <= MANIFEST_ATTEMPTS; attempt += 1) {
    const { version, manifest } = await readVersionAndManifest(siteBucket);
    const next = upsertPhoto(manifest, record);
    const counts = countTypes(next.photos);
    const rev = sha256(Buffer.from(JSON.stringify(next), 'utf8')).slice(0, 12);
    const manifestKey = `data/manifest.${rev}.json`;

    // 先写清单、后写指针：中间断掉只是多一份孤儿清单，页面仍渲染旧版本；
    // 顺序反了就会有一段时间「指针指向不存在的文件」，整站白屏。
    await store.putJson(siteBucket, manifestKey, next, {
      cacheControl: store.CACHE_IMMUTABLE,
    });

    try {
      await store.putJsonConditional(siteBucket, versionKey, {
        rev,
        manifest: manifestKey,
        counts,
      }, {
        cacheControl: store.CACHE_NO_STORE,
        ifMatch: version?.etag || null,
        ifNoneMatch: version ? null : '*',
      });
      return { rev, manifestKey, counts, attempts: attempt };
    } catch (err) {
      if (!store.isPreconditionFailed(err)) throw err;
      // 别人先写了一步，重读再合并。抖动一下，避免两个实例同步重试又撞上。
      log.info('manifest.contended', { attempt, rev });
      await sleep(backoffMs(attempt, MANIFEST_RETRY_MS));
    }
  }

  throw new Error(`清单更新冲突，重试 ${MANIFEST_ATTEMPTS} 次仍失败 / manifest contention`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function artifactsExist(siteBucket, id, kind) {
  // 视频可能被降级成静图（只剩三档图），所以两种产物都要探：
  // 只探 clip.mp4 的话，降级过的视频每次重传都会被重新转码一遍。
  const probes = kind === 'video'
    ? [`photos/${id}/clip.mp4`, `photos/${id}/view.webp`]
    : [`photos/${id}/view.webp`];

  for (const probe of probes) {
    if (await store.head(siteBucket, probe)) return true;
  }
  return false;
}

async function processObject({ bucket, key }) {
  const prefix = env('INCOMING_PREFIX', 'incoming/');
  if (!key.startsWith(prefix)) {
    log.info('process.outside_prefix', { key });
    return { skipped: true };
  }

  const siteBucket = env('SITE_BUCKET');
  const meta = await store.head(bucket, key);
  if (!meta) {
    // 事件比对象先到、或对象已被别处删除，都不该重试
    log.warn('process.source_missing', { key });
    return { skipped: true };
  }

  const kind = kindOf(meta.contentType, key);
  if (!kind) {
    log.error('process.unsupported', { key, contentType: meta.contentType });
    throw new Error(`不支持的类型 / unsupported content type: ${meta.contentType}`);
  }

  const workDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(workDir, { recursive: true });

  try {
    const { manifest: current } = await readVersionAndManifest(siteBucket);

    // 图片整段读进内存（30MB 上限），视频落盘（200MB 上限，还能更大）
    let buffer = null;
    let sourceFile = '';
    let sha;
    if (kind === 'image') {
      buffer = await store.getBuffer(bucket, key);
      sha = sha256(buffer);
    } else {
      sourceFile = path.join(workDir, 'source');
      ({ sha256: sha } = await store.downloadToFile(bucket, key, sourceFile));
    }

    if (meta.metadata.sha256 && meta.metadata.sha256 !== sha) {
      // 客户端上报的哈希与实际字节不符：以实际字节为准，只留一条告警
      log.warn('process.hash_mismatch', {
        key,
        claimed: meta.metadata.sha256.slice(0, 12),
        actual: sha.slice(0, 12),
      });
    }

    const id = sha.slice(0, 12);
    const album = decodeAlbum(meta.metadata.album);
    const known = current.photos.some((photo) => photo && photo.id === id);

    if (known && await artifactsExist(siteBucket, id, kind)) {
      log.info('process.duplicate', { id });
      await store.remove(bucket, key);
      return { id, skipped: true };
    }

    let record;
    let gridBuffer = null; // 脱敏派生图：识别输入（T-08），视频无 grid 不识别
    if (kind === 'image') {
      const image = await processImage(buffer);
      await writeArtifacts(siteBucket, id, image.buffers);
      record = imageRecord({ id, album, image, meta });
      gridBuffer = image.buffers['grid.webp'] || null;
    } else {
      const clipPath = path.join(workDir, 'clip.mp4');
      const video = await processVideo({ srcPath: sourceFile, tmpDir: workDir, clipPath });

      if (video.degraded) {
        // 降级：只剩封面，按静图入库，保证页面上仍能看到这一条
        log.warn('process.video_degraded', { id, reason: video.reason });
        const image = await processImage(video.poster);
        await writeArtifacts(siteBucket, id, image.buffers);
        record = imageRecord({
          id, album, image, meta, videoShotAt: video.videoShotAt,
        });
        gridBuffer = image.buffers['grid.webp'] || null;
      } else {
        await writeArtifacts(siteBucket, id, {
          'clip.mp4': video.clip,
          'poster.webp': video.poster,
        });
        record = videoRecord({ id, album, video, meta });
      }
    }

    const { rev } = await commitManifest(siteBucket, record);
    const versionKey = env('VERSION_KEY', 'data/version.json');

    // 识别 + 索引发布：best-effort，任何失败只留日志，绝不阻塞照片上线
    // （FR-02、硬性不变量 2）。recognition=null 时索引仍重建，
    // 新照片以 source=manifest 条目入索引，基础筛选可用。
    // Recognition + index publish: best-effort, failures only log and never
    // block publication (FR-02, hard invariant 2). With recognition=null the
    // index still rebuilds so the photo enters as a source=manifest entry.
    const startedAt = Date.now();
    let recognition = null;
    if (gridBuffer) {
      try {
        recognition = await recognizeGrid({ assetId: id, gridBuffer });
      } catch (err) {
        log.warn('process.recognition_failed', { id, ...errorFields(err) });
      }
    }
    let published = { rev: null, items: 0, recognized: 0 };
    try {
      published = await publishRecognition({ siteBucket, assetId: id, recognition });
    } catch (err) {
      log.warn('process.index_publish_failed', { id, ...errorFields(err) });
    }
    log.info('process.recognition', {
      id,
      outcome: recognition ? 'recognized' : 'unlabeled',
      rev: published.rev ? published.rev.slice(0, 12) : null,
      recognized: published.recognized ?? 0,
      durationMs: Date.now() - startedAt,
    });

    // 失效失败不该让整次处理重来：version.json 本身就是 no-store，
    // 最坏情况是极少数边缘节点多缓存几秒。
    try {
      const distributionId = env('DISTRIBUTION_ID', '');
      if (distributionId) {
        await store.invalidate(distributionId, [`/${versionKey}`, '/data/search-index*']);
      }
    } catch (err) {
      log.warn('process.invalidate_failed', errorFields(err));
    }

    // P02：产物与清单都写成功之后才删源图。反序 = 一旦中途失败，素材就没了。
    await store.remove(bucket, key);

    log.info('process.done', {
      id,
      kind: record.type,
      album,
      year: record.year,
      month: record.month,
      rev,
    });
    return { id, rev };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function imageRecord({ id, album, image, meta, videoShotAt }) {
  const { year, month } = resolveYearMonth({
    takenAt: parseIso(meta.metadata['taken-at']),
    exifShotAt: image.exifShotAt,
    // 视频降级成静图时，拍摄时间来自视频容器标签（绝对时刻），不能塞进 exifShotAt
    videoShotAt,
    lastModified: meta.lastModified,
  });

  return {
    id,
    type: 'image',
    album,
    year,
    month,
    tags: tagsFor(album, year),
    title: '',
    caption: '',
    ratio: image.ratio,
    lqip: image.lqip,
    featured: false,
    thumb: `photos/${id}/thumb.webp`,
    grid: `photos/${id}/grid.webp`,
    view: `photos/${id}/view.webp`,
  };
}

function videoRecord({ id, album, video, meta }) {
  const { year, month } = resolveYearMonth({
    takenAt: parseIso(meta.metadata['taken-at']),
    videoShotAt: video.videoShotAt,
    lastModified: meta.lastModified,
  });

  return {
    id,
    type: 'video',
    album,
    year,
    month,
    tags: tagsFor(album, year),
    title: '',
    caption: '',
    ratio: video.ratio,
    lqip: video.lqip,
    featured: false,
    poster: `photos/${id}/poster.webp`,
    src: `photos/${id}/clip.mp4`,
    duration: video.duration,
  };
}

export async function handler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (!records.length) {
    log.warn('process.empty_event');
    return { processed: 0 };
  }

  const done = [];
  for (const record of records) {
    const bucket = record?.s3?.bucket?.name;
    const key = decodeKey(record?.s3?.object?.key);
    if (!bucket || !key) {
      log.warn('process.bad_record');
      continue;
    }
    try {
      done.push(await processObject({ bucket, key }));
    } catch (err) {
      // 抛出 → 异步重试 2 次 → 仍失败进死信队列；源图留在源桶等生命周期兜底
      log.error('process.failed', { key, ...errorFields(err) });
      throw err;
    }
  }

  return { processed: done.length };
}
