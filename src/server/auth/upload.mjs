import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, envInt } from '../lib/config.mjs';
import { planFiles, signableHeaderNames } from './rules.mjs';

/**
 * 签发预签名 PUT。
 *
 * key 用「内容哈希前 16 位 + 原扩展名」，于是「同一张图传两次」天然落到同一个
 * 对象上，不需要额外的去重表。校验规则见 rules.mjs（那边是纯函数，可单测）。
 *
 * Keys are `first 16 hex of sha256 + original extension`, so uploading the same
 * photo twice lands on the same object with no dedupe table. Validation lives in
 * rules.mjs as pure, testable functions.
 */

let client;
function s3() {
  client ??= new S3Client({});
  return client;
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

  const items = await Promise.all(plan.items.map(async (entry) => {
    // 空值不写进元数据，免得对象上挂一堆空串
    const metadata = Object.fromEntries(
      Object.entries(entry.metadata).filter(([, value]) => value !== ''),
    );

    // ContentType 与 x-amz-meta-* 必须显式进签名：默认只有「必须签」的少数
    // 几个头进签名范围，其余的头客户端一发上来就会被 S3 判为「未签名头」并
    // 回 403。这样做同时挡住「把 HTML 伪装成图片直传」，也让相册与拍摄时间
    // 随对象落到 S3，处理函数不必回查数据库。
    // ContentType and every x-amz-meta-* must be force-signed: by default only a
    // few required headers enter the signature, so anything else the client
    // sends is rejected with 403 `headers not signed`. It also blocks uploading
    // HTML disguised as an image and carries album/taken-at with the object.
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
  }));

  return { items };
}
