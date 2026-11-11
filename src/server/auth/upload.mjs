import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, envInt } from '../lib/config.mjs';
import { planFiles } from './rules.mjs';

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

    // ContentType 与 x-amz-meta-* 一起进签名：既防止把一个 HTML 文件伪装成
    // 图片直传上来，也让「相册 / 拍摄时间」随对象一起落到 S3，
    // 处理函数不必回查任何数据库。
    // ContentType and x-amz-meta-* are part of the signature, which blocks
    // uploading HTML disguised as an image and carries album/taken-at with the
    // object so the processor needs no lookup.
    const url = await getSignedUrl(
      s3(),
      new PutObjectCommand({
        Bucket: bucket,
        Key: entry.key,
        ContentType: entry.contentType,
        Metadata: metadata,
      }),
      { expiresIn },
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
