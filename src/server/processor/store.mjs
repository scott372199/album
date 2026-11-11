import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import {
  S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';

/**
 * S3 / CloudFront 薄封装。除了把命令包一层，这里只做两件事：
 * 统一缓存头、统一「不存在」的表示（返回 null 而不是抛 404 异常）。
 *
 * Thin S3/CloudFront wrapper. Beyond packaging commands it only does two
 * things: standardise cache headers, and represent "missing" as null instead
 * of a thrown 404.
 */

export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_NO_STORE = 'no-store';

let s3Client;
let cfClient;

const s3 = () => (s3Client ??= new S3Client({}));
const cf = () => (cfClient ??= new CloudFrontClient({}));

function isNotFound(err) {
  return err?.$metadata?.httpStatusCode === 404
    || err?.name === 'NoSuchKey'
    || err?.name === 'NotFound';
}

export async function head(bucket, key) {
  try {
    const response = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentType: response.ContentType || '',
      contentLength: Number(response.ContentLength || 0),
      metadata: response.Metadata || {},
      lastModified: response.LastModified || null,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function getBuffer(bucket, key) {
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * 流式落盘并同时算哈希：视频动辄上百 MB，整段读进内存既浪费又容易触发
 * 内存上限。顺带的收益是哈希与落盘一次完成，不用读两遍。
 *
 * Streams to disk while hashing: videos run to hundreds of megabytes, so
 * buffering them wastes memory and risks the limit. Hashing inline also avoids
 * a second pass over the bytes.
 */
export async function downloadToFile(bucket, key, file) {
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hash = createHash('sha256');
  let bytes = 0;

  const sink = createWriteStream(file);
  try {
    for await (const chunk of response.Body) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!sink.write(chunk)) await once(sink, 'drain');
    }
  } finally {
    await new Promise((resolve, reject) => {
      sink.end((err) => (err ? reject(err) : resolve()));
    });
  }

  return { bytes, sha256: hash.digest('hex') };
}

export async function putBuffer(bucket, key, body, { contentType, cacheControl }) {
  await s3().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

export async function putJson(bucket, key, value, { cacheControl }) {
  await putBuffer(bucket, key, Buffer.from(JSON.stringify(value), 'utf8'), {
    contentType: 'application/json; charset=utf-8',
    cacheControl,
  });
}

/** 读 JSON；不存在返回 null，损坏则抛错（损坏不能当成「空的」悄悄覆盖掉） */
export async function readJson(bucket, key) {
  let buffer;
  try {
    buffer = await getBuffer(bucket, key);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`JSON 解析失败 / cannot parse ${key}: ${err.message}`);
  }
}

export async function remove(bucket, key) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function invalidate(distributionId, paths) {
  const response = await cf().send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: `album-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      Paths: { Quantity: paths.length, Items: paths },
    },
  }));
  return response.Invalidation?.Id || '';
}
