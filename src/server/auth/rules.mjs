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
 * 校验整批文件并给出每个对象的 key 与元数据。
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
