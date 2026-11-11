import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * 处理流程里的纯函数：不碰网络、不碰文件系统，因此可以直接单测。
 * 这些函数恰好是最容易出错的部分（时区、URL 解码、类型判定），
 * 把它们从 handler 里拆出来就是为了能被反复验证。
 *
 * Pure helpers for the pipeline: no network, no filesystem, so they can be
 * unit tested directly. They also happen to be the easiest places to get wrong
 * (time zones, URL decoding, type sniffing), which is why they live apart from
 * the handler.
 */

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v']);

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** S3 事件里的键是 URL 编码的，中文相册名会带 %E4 之类 */
export function decodeKey(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

export function kindOf(contentType, key) {
  const type = String(contentType || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  const ext = path.extname(String(key || '')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** 相册名以 base64url 走对象元数据：S3 元数据只接受 ASCII */
export function decodeAlbum(value) {
  if (!value) return '未分类';
  try {
    const text = Buffer.from(String(value), 'base64url').toString('utf8').trim();
    return text || '未分类';
  } catch {
    return '未分类';
  }
}

export function parseIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 四个时间来源的语义各不相同，必须分开处理：
 *   takenAt（客户端，带时区）  → 绝对时刻
 *   videoShotAt（容器标签，带时区）→ 绝对时刻
 *   lastModified（S3，UTC）    → 绝对时刻
 *   exifShotAt（EXIF，无时区） → 本来就是「相机上的墙上时间」
 *
 * 绝对时刻要换算到 UTC+8 再取年月，否则「11 月 1 日清晨拍的照片」会掉进 10 月；
 * 而 EXIF 的墙上时间直接取 UTC 字段就是对的，再换算反而会错。
 *
 * Four sources with different meanings. Absolute instants are shifted to UTC+8
 * before taking year/month, otherwise an early-morning Nov 1 shot lands in
 * October. EXIF is already wall-clock, so its UTC fields are correct as-is and
 * shifting would introduce the very bug we are avoiding.
 */
export function resolveYearMonth({ takenAt, exifShotAt, videoShotAt, lastModified } = {}) {
  const absolute = (date) => {
    const shifted = new Date(date.getTime() + CN_OFFSET_MS);
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
  };
  const wallClock = (date) => ({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });

  if (takenAt) return absolute(takenAt);
  if (exifShotAt) return wallClock(exifShotAt);
  if (videoShotAt) return absolute(videoShotAt);
  if (lastModified) return absolute(lastModified);
  return absolute(new Date());
}

export function tagsFor(album, year) {
  return [...new Set([album, String(year)])].filter(Boolean);
}
