import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import {
  S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { isPreconditionFailed } from '../lib/retry.mjs';
import { invalidationCallerReference } from '../v5/correlation.mjs';

export { isPreconditionFailed };

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

/**
 * 读 JSON 并带回 ETag。
 *
 * 条件写要靠这个 ETag 判断「我读的这一版还是不是最新的」。S3 的 If-Match
 * 用的是带引号的原样值，所以这里不剥引号。
 *
 * Reads JSON together with its ETag, which conditional writes use to tell
 * whether the version we read is still current. The quoted form is kept as-is
 * because that is what If-Match expects.
 */
export async function getJsonWithEtag(bucket, key) {
  let response;
  try {
    response = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const bytes = await response.Body.transformToByteArray();
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    throw new Error(`JSON 解析失败 / cannot parse ${key}: ${err.message}`);
  }
  return { value, etag: response.ETag || null };
}

/**
 * 带前置条件的 JSON 写。
 *
 * `ifMatch` 是「只有当前对象还是这一版才写」；`ifNoneMatch: '*'` 是「不存在
 * 才写」。两者都给就给不出去——调用方按对象是否存在二选一。
 *
 * Conditional JSON write: `ifMatch` means "only if the object is still this
 * version", `ifNoneMatch: '*'` means "only if it does not exist yet".
 */
export async function putJsonConditional(
  bucket, key, value, { cacheControl, ifMatch, ifNoneMatch },
) {
  const command = {
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(JSON.stringify(value), 'utf8'),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: cacheControl,
  };
  if (ifMatch) command.IfMatch = ifMatch;
  else if (ifNoneMatch) command.IfNoneMatch = ifNoneMatch;
  await s3().send(new PutObjectCommand(command));
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

/**
 * 分页列出某前缀下的所有 key（ListObjectsV2 自动翻页）。
 * maxKeys 是防御性上限：超过即停，避免一次失控调用把内存吃满。
 *
 * Lists every key under a prefix with automatic pagination. maxKeys is a
 * defensive cap: stop rather than balloon memory on a runaway call.
 */
export async function listKeys(bucket, prefix, { maxKeys = 10000 } = {}) {
  const keys = [];
  let token;
  do {
    const response = await s3().send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const item of response.Contents || []) {
      if (item?.Key) keys.push(item.Key);
      if (keys.length >= maxKeys) return keys;
    }
    token = response.IsTruncated ? response.NextContinuationToken : null;
  } while (token);
  return keys;
}

/**
 * 失效批次带上 correlation ID：CloudFront 的 CallerReference 会出现在
 * GetInvalidation 与 CloudTrail 里，于是 CDN 刷新也能并进同一次上传的追踪链。
 * 尾部时间戳 + 随机串保证每次请求唯一，不会被 CloudFront 当成重复提交。
 *
 * The correlation ID travels in the CloudFront CallerReference (visible in
 * GetInvalidation / CloudTrail), joining the CDN refresh to the same upload
 * trace. A timestamp + random suffix keeps each request unique so CloudFront
 * does not deduplicate a legitimate retry.
 */
export async function invalidate(distributionId, paths, { correlationId = '' } = {}) {
  const response = await cf().send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: invalidationCallerReference(correlationId),
      Paths: { Quantity: paths.length, Items: paths },
    },
  }));
  return response.Invalidation?.Id || '';
}
