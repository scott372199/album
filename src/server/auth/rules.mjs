/**
 * 上传请求的纯校验逻辑：不碰网络，因此可以逐个分支单测。
 * 这里的每条规则都对应一个真实的失败场景，不是形式主义。
 *
 * Pure validation for upload requests, unit-testable branch by branch. Every
 * rule here maps to a real failure mode rather than ceremony.
 */

export const TYPES = {
  '.jpg': { contentType: 'image/jpeg', kind: 'image' },
  '.jpeg': { contentType: 'image/jpeg', kind: 'image' },
  '.png': { contentType: 'image/png', kind: 'image' },
  '.webp': { contentType: 'image/webp', kind: 'image' },
  '.heic': { contentType: 'image/heic', kind: 'image' },
  '.heif': { contentType: 'image/heif', kind: 'image' },
  '.gif': { contentType: 'image/gif', kind: 'image' },
  '.mp4': { contentType: 'video/mp4', kind: 'video' },
  '.mov': { contentType: 'video/quicktime', kind: 'video' },
  '.m4v': { contentType: 'video/x-m4v', kind: 'video' },
};

export const DEFAULT_ALBUM = '未分类';
const MAX_ALBUM_LENGTH = 40;

/** S3 硬规矩：除最后一片外，每片不得小于 5MB；总片数不得超过 10000 */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
export const MAX_PARTS = 10000;

/**
 * 要不要走分片，以及切几片。
 *
 * 分片不是为了「快点」，是为了让一次失败只丢 8MB 而不是整个 150MB，
 * 顺便把「把整段视频读进内存再发」这条脆弱路径彻底去掉。
 *
 * Multipart is not about speed: it makes a failure cost one 8 MB part instead of
 * the whole video, and removes the fragile "read the entire file into memory" path.
 */
export function multipartPlan(size, { threshold, partSize }) {
  if (!(size > threshold)) return null;
  if (partSize < MIN_PART_SIZE) return { error: 'part_too_small' };
  const parts = Math.ceil(size / partSize);
  if (parts > MAX_PARTS) return { error: 'too_many_parts', max: MAX_PARTS };
  return { parts, partSize };
}

export function extensionOf(name) {
  const match = /\.[a-z0-9]+$/i.exec(String(name || ''));
  return match ? match[0].toLowerCase() : '';
}

/** 相册名会进清单并被渲染，去掉控制字符与路径分隔符 */
export function sanitizeAlbum(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .trim();
  if (!text) return DEFAULT_ALBUM;
  return text.slice(0, MAX_ALBUM_LENGTH);
}

function normalizeTakenAt(value) {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

/**
 * 元数据对应的 x-amz-meta-* 头名。
 *
 * Metadata 在预签名里有一个反直觉行为：SDK 默认把 x-amz-meta-* **提到查询串**
 * 里（hoist），于是 URL 上出现 x-amz-meta-album=... 的 query，而签名头里只剩
 * content-type;host。客户端如果照常把这些值放在请求头里发出，S3 就看到一批
 * 「没进签名的头」并回 403。
 *
 * 所以这些头必须同时进两个集合：
 *   signableHeaders   —— 让它们进签名范围
 *   unhoistableHeaders —— 把它们留在请求头里，别挪到查询串
 * 只给 signableHeaders 是不够的（实测 SignedHeaders 仍是 content-type;host）。
 *
 * Metadata headers carry a counter-intuitive detail: the SDK hoists x-amz-meta-*
 * into the query string by default, so the client's real headers end up
 * unsigned and S3 answers 403. They must be listed in BOTH signableHeaders and
 * unhoistableHeaders; signableHeaders alone is not enough.
 */
export function metadataHeaderNames(metadata) {
  return Object.keys(metadata || {}).map((name) => {
    const lower = name.toLowerCase();
    // 名字必须与真正发出去的头完全一致，否则 S3 回 SignatureDoesNotMatch
    return lower.startsWith('x-amz-meta-') ? lower : `x-amz-meta-${lower}`;
  });
}

/**
 * 需要强制进签名的请求头清单：content-type 加全部元数据头。
 * Headers to force into the signature: content-type plus every metadata header.
 */
export function signableHeaderNames(contentType, metadata) {
  const names = [];
  if (contentType) names.push('content-type');
  for (const name of metadataHeaderNames(metadata)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 合并分片的入参校验。
 *
 * 这个接口拿着有效令牌就能调，所以 key 必须落在 `incoming/` 且形状和签发时一致，
 * etag 必须是 S3 的十六进制（可带引号、可带 `-N` 后缀）。否则它会变成
 * 「指定任意 key 去合并」的洞。
 *
 * Validates the merge request. A valid token can call this endpoint, so the key
 * must look exactly like what we signed and the etags must be real S3 etags.
 */
const KEY_RE = /^[a-z0-9-]+\/[0-9a-f]{16}\.[a-z0-9]+$/;
const ETAG_RE = /^"?[0-9a-f]{32}(-\d+)?"?$/i;

export function parseComplete(body, prefix = 'incoming/') {
  const key = String(body?.key || '');
  const uploadId = String(body?.uploadId || '');
  const list = Array.isArray(body?.parts) ? body.parts : [];

  // 形状对还不够，还必须落在签发时用的前缀里：否则「合并」就成了
  // 往 photos/ 或者别的任何地方写对象的口子。
  if (!KEY_RE.test(key) || !key.startsWith(prefix)) return { error: 'invalid_key' };
  if (!uploadId || uploadId.length > 1024) return { error: 'invalid_upload_id' };
  if (!list.length || list.length > MAX_PARTS) return { error: 'invalid_parts' };

  const parts = [];
  for (const item of list) {
    const partNumber = Number(item?.partNumber);
    const etag = String(item?.etag || '');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      return { error: 'invalid_part_number' };
    }
    if (!ETAG_RE.test(etag)) return { error: 'invalid_etag' };
    parts.push({ PartNumber: partNumber, ETag: etag });
  }
  // S3 要求按序号升序，乱序会直接报 InvalidPartOrder
  parts.sort((left, right) => left.PartNumber - right.PartNumber);

  return { key, uploadId, parts };
}

/**
 * 校验整批文件并给出每个对象的 key、体积与元数据。
 *
 * 只要有一个文件不合规就整批拒绝：半个批次成功会让客户端的分批重试变得
 * 难以推理，而重试的代价不过是再点一次。
 *
 * Rejects the whole batch on any violation: a partial success makes client-side
 * retry logic hard to reason about, and retrying costs one tap.
 */
export function planFiles(files, { maxFiles, maxImage, maxVideo, prefix, album }) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { error: 'no_files' };
  if (list.length > maxFiles) return { error: 'too_many_files', max: maxFiles };

  const seen = new Set();
  const items = [];

  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    if (!file || typeof file !== 'object') return { error: 'invalid_file', index };

    const ext = extensionOf(file.name);
    const spec = TYPES[ext];
    // 扩展名白名单同时承担「不允许上传 .html/.svg」的职责：
    // 那些类型在站点域名下渲染等于给自己开一个 XSS 口子
    if (!spec) return { error: 'unsupported_type', index, ext };

    const sha256 = String(file.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) return { error: 'invalid_sha256', index };

    const size = Number(file.size);
    const limit = spec.kind === 'video' ? maxVideo : maxImage;
    if (!Number.isFinite(size) || size <= 0) return { error: 'invalid_size', index };
    if (size > limit) return { error: 'file_too_large', index, limit };

    const key = `${prefix}${sha256.slice(0, 16)}${ext}`;
    // 同一批里重复的文件只签一个地址，客户端按 key 复用
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      key,
      // 体积决定「单次 PUT」还是「分片」，所以必须带出来
      size,
      contentType: spec.contentType,
      metadata: {
        album: Buffer.from(sanitizeAlbum(album), 'utf8').toString('base64url'),
        'taken-at': normalizeTakenAt(file.takenAt),
        sha256,
      },
    });
  }

  return { items };
}
