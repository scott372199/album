import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, envInt } from '../lib/config.mjs';
import {
  planFiles, metadataHeaderNames, signableHeaderNames, multipartPlan, parseComplete,
} from './rules.mjs';

/**
 * 签发上传地址。
 *
 * key 用「内容哈希前 16 位 + 原扩展名」，于是「同一张图传两次」天然落到同一个
 * 对象上，不需要额外的去重表。校验规则见 rules.mjs（那边是纯函数，可单测）。
 *
 * 小文件签一个 PUT；超过阈值的签一组分片地址，由客户端逐片上传、最后调
 * /upload-complete 合并。分片的理由很实际：真机上一条 100MB+ 的单次 PUT
 * 会以「0 字节 + 0.4 秒」失败（浏览器拿不到 content:// 文件描述符），而且
 * 一断就得从头再来。切成 8MB 之后，每片都是一次独立的小请求，失败只补那一片。
 *
 * Keys are `first 16 hex of sha256 + original extension`, so uploading the same
 * photo twice lands on the same object with no dedupe table. Small files get a
 * single presigned PUT; anything larger gets one presigned URL per 8 MB part plus
 * a server-side CompleteMultipartUpload.
 */

/** 超过这个体积就走分片。8MB 的图片基本不存在，所以实际只影响视频。 */
const multipartThreshold = () => envInt('MULTIPART_THRESHOLD', 16 * 1024 * 1024);
const partSize = () => envInt('MULTIPART_PART_SIZE', 8 * 1024 * 1024);

let client;
function s3() {
  client ??= new S3Client({});
  return client;
}

/** 空值不写进元数据，免得对象上挂一堆空串 */
function cleanMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata || {}).filter(([, value]) => value !== ''));
}

/**
 * ContentType 与 x-amz-meta-* 必须显式进签名，**并且**禁止被提到查询串：
 * SDK 默认把元数据搬进 query，签名头里只剩 content-type;host，客户端照常
 * 用请求头发出去就被 S3 判成「未签名头」回 403。两边都传才既进签名又留在
 * 请求头里。顺带挡住「把 HTML 伪装成图片直传」，并让相册与拍摄时间随对象
 * 落到 S3，处理函数不必回查数据库。
 *
 * ContentType and every x-amz-meta-* must be signed AND kept out of the query
 * string: by default the SDK hoists metadata into the query, leaving only
 * content-type;host signed, so the client's real headers are rejected with 403.
 */
async function presignSingle(bucket, entry, expiresIn) {
  const metadata = cleanMetadata(entry.metadata);
  const metaHeaders = metadataHeaderNames(metadata);
  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: entry.key,
      ContentType: entry.contentType,
      Metadata: metadata,
    }),
    {
      expiresIn,
      signableHeaders: new Set(signableHeaderNames(entry.contentType, metadata)),
      unhoistableHeaders: new Set(metaHeaders),
    },
  );

  return {
    key: entry.key,
    url,
    method: 'PUT',
    headers: {
      'content-type': entry.contentType,
      ...Object.fromEntries(
        Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name}`, value]),
      ),
    },
    expiresIn,
  };
}

/**
 * 分片：先 CreateMultipartUpload 定下 key、ContentType 与元数据，
 * 再把每一片的 UploadPart 地址签出来。
 *
 * 片的请求**不带任何自定义头**：元数据在 create 时就定死了，片上再带头反而
 * 会变成「未签名头」。于是每一片都是一个简单请求，连预检都不需要。
 *
 * Metadata and content type are fixed at CreateMultipartUpload, so individual part
 * requests carry no custom headers at all — each one is a simple request.
 */
async function presignParts(bucket, entry, expiresIn) {
  const plan = multipartPlan(entry.size, {
    threshold: multipartThreshold(),
    partSize: partSize(),
  });
  if (plan?.error) return plan;

  const created = await s3().send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: entry.key,
    ContentType: entry.contentType,
    Metadata: cleanMetadata(entry.metadata),
  }));
  const uploadId = created.UploadId;
  if (!uploadId) return { error: 'multipart_create_failed' };

  const parts = await Promise.all(
    Array.from({ length: plan.parts }, async (_, index) => {
      const partNumber = index + 1;
      const url = await getSignedUrl(
        s3(),
        new UploadPartCommand({
          Bucket: bucket, Key: entry.key, UploadId: uploadId, PartNumber: partNumber,
        }),
        { expiresIn },
      );
      return { partNumber, url };
    }),
  );

  return {
    key: entry.key,
    multipart: true,
    uploadId,
    partSize: plan.partSize,
    parts,
    expiresIn,
  };
}

export async function presignUploads(body) {
  const plan = planFiles(body.files, {
    maxFiles: envInt('MAX_FILES', 20),
    maxImage: envInt('MAX_IMAGE_BYTES', 30 * 1024 * 1024),
    maxVideo: envInt('MAX_VIDEO_BYTES', 200 * 1024 * 1024),
    prefix: env('INCOMING_PREFIX', 'incoming/'),
    album: body.album,
  });
  if (plan.error) return plan;

  const bucket = env('SOURCE_BUCKET');
  const expiresIn = envInt('PRESIGN_TTL', 900);

  // 分片计划本身也可能失败（片太小 / 片太多），整批同样拒绝
  const items = await Promise.all(plan.items.map(async (entry) => {
    const item = entry.size > multipartThreshold()
      ? await presignParts(bucket, entry, expiresIn)
      : await presignSingle(bucket, entry, expiresIn);
    return item.error ? { ...item, failed: true } : item;
  }));

  const failure = items.find((item) => item.failed);
  if (failure) return { error: failure.error, max: failure.max };

  return { items };
}

/**
 * 合并分片。这一步**不能**让客户端直接打 S3：CompleteMultipartUpload 要一个
 * 带 XML 体的签名请求，交给浏览器签不现实，也不该把 S3 的错误细节暴露给前端。
 * 入参校验放在 rules.mjs 的 `parseComplete`（纯函数，可单测）。
 *
 * CompleteMultipartUpload runs server-side: presigning an XML body for the browser
 * is impractical. Request validation lives in rules.mjs as a pure function.
 */
export async function completeMultipart(body) {
  const parsed = parseComplete(body, env('INCOMING_PREFIX', 'incoming/'));
  if (parsed.error) return parsed;

  const result = await s3().send(new CompleteMultipartUploadCommand({
    Bucket: env('SOURCE_BUCKET'),
    Key: parsed.key,
    UploadId: parsed.uploadId,
    MultipartUpload: { Parts: parsed.parts },
  }));

  return { key: parsed.key, parts: parsed.parts.length, etag: result.ETag || '' };
}
