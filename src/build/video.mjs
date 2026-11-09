import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const MAX_SECONDS = 30;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_EDGE = 1920;
const FPS = 30;

const FORBIDDEN_TAG_KEY = /location|gps|make$|model$|software|creation_time|com\.apple|artist|copyright|lens/i;

async function run(bin, args) {
  try {
    return await execFileAsync(bin, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim().split('\n').slice(-3).join(' | ') : err.message;
    throw new Error(`${bin} 执行失败：${detail}`);
  }
}

export async function probeVideo(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const data = JSON.parse(stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error(`未找到视频流：${file}`);

  const rotation = Number(
    video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation
    ?? video.tags?.rotate
    ?? 0,
  ) || 0;

  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  const tags = data.format?.tags ?? {};

  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    rotation,
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: Boolean(audio),
    tags,
    streamTags: Object.assign({}, ...streams.map((s) => s.tags ?? {})),
    codec: video.codec_name,
  };
}

/** 旋转 90/270 时显示尺寸与编码尺寸互换 */
export function displayedSize({ width, height, rotation }) {
  const swapped = Math.abs(rotation) % 180 === 90;
  return swapped ? { width: height, height: width } : { width, height };
}

/** 等比缩到最长边 <= MAX_EDGE，并保证输出为偶数（H.264 要求） */
export function targetSize({ width, height }) {
  const longEdge = Math.max(width, height) || 1;
  const scale = Math.min(1, MAX_EDGE / longEdge);
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

function parseCreationDate(tags, streamTags) {
  const raw = tags['com.apple.quicktime.creationdate']
    || tags.creation_time
    || streamTags.creation_time;
  if (!raw) return null;
  const normalized = String(raw).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function transcodeArgs({ src, dest, width, height, crf, hasAudio }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-t', String(MAX_SECONDS),
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-fflags', '+bitexact',
    '-vf', `scale=${width}:${height}:flags=lanczos,fps=${FPS}`,
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.0',
    '-pix_fmt', 'yuv420p',
    '-crf', String(crf),
    '-preset', 'medium',
    '-g', String(FPS * 2),
    '-movflags', '+faststart',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2'] : ['-an']),
    dest,
  ];
}

/** 转码后必须复查：容器与流上都不能留下任何可识别信息 */
export async function assertCleanVideo(file) {
  const data = await probeVideo(file);
  const offenders = [];

  for (const [key, value] of Object.entries(data.tags)) {
    if (/^(major_brand|minor_version|compatible_brands)$/.test(key)) continue;
    if (FORBIDDEN_TAG_KEY.test(key)) offenders.push(`format.tags.${key}`);
    if (/iPhone|iPad|Apple|iOS/i.test(String(value))) offenders.push(`format.tags.${key}=${value}`);
  }
  for (const [key, value] of Object.entries(data.streamTags)) {
    if (key === 'handler_name') {
      if (!/Handler$/i.test(String(value))) offenders.push(`${key}=${value}`);
      continue;
    }
    if (key === 'language' || key === 'vendor_id' || key === 'encoder') continue;
    if (FORBIDDEN_TAG_KEY.test(key)) offenders.push(`stream.tags.${key}`);
  }

  if (offenders.length) {
    throw new Error(`视频脱敏失败：${path.basename(file)} 仍含 ${offenders.join(', ')}`);
  }
  return data;
}

async function makePoster(clipPath, outDir, duration, tmpDir) {
  const frameFile = path.join(tmpDir, `poster-${Date.now()}.png`);
  const seek = Math.min(1, Math.max(0, duration / 3));
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(seek), '-i', clipPath,
    '-frames:v', '1', frameFile,
  ]);

  const posterFile = path.join(outDir, 'poster.webp');
  await sharp(frameFile).resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 76 }).toFile(posterFile);
  const meta = await sharp(posterFile).metadata();
  if (meta.exif) throw new Error(`封面脱敏失败：${posterFile} 仍含 EXIF`);
  await rm(frameFile, { force: true });

  const lqipBuffer = await sharp(posterFile).resize({ width: 24 }).webp({ quality: 40 }).toBuffer();
  return `data:image/webp;base64,${lqipBuffer.toString('base64')}`;
}

/**
 * 处理一条视频：探测 → 转码 → 封面 → 脱敏复查。
 * 返回可写入 manifest 的资产描述与用于排序的拍摄时间。
 */
export async function processVideo(photo, distRoot, tmpDir) {
  const src = photo.videoPath || photo.srcPath;
  const outDir = path.join(distRoot, 'photos', photo.id);
  await mkdir(outDir, { recursive: true });

  const info = await probeVideo(src);
  const displayed = displayedSize(info);
  const size = targetSize(displayed);
  const ratio = displayed.height ? Number((displayed.width / displayed.height).toFixed(4)) : 1;

  const dest = path.join(outDir, 'clip.mp4');
  let degraded = false;

  await run('ffmpeg', transcodeArgs({
    src, dest, width: size.width, height: size.height, crf: 23, hasAudio: info.hasAudio,
  }));

  let bytes = (await stat(dest)).size;
  if (bytes > MAX_BYTES) {
    await run('ffmpeg', transcodeArgs({
      src, dest, width: size.width, height: size.height, crf: 28, hasAudio: info.hasAudio,
    }));
    bytes = (await stat(dest)).size;
  }

  if (bytes > MAX_BYTES) {
    // 仍然过大：放弃视频，只留封面，按静图处理
    await rm(dest, { force: true });
    degraded = true;
  }

  const clean = degraded ? null : await assertCleanVideo(dest);
  const duration = Math.min(Number(clean?.duration || info.duration), MAX_SECONDS);
  const lqip = await makePoster(degraded ? src : dest, outDir, duration, tmpDir);

  const createdAt = parseCreationDate(info.tags, info.streamTags);
  return {
    degraded,
    createdAt,
    meta: {
      ratio,
      duration: Number(duration.toFixed(2)),
      width: size.width,
      height: size.height,
      bytes,
      hasAudio: info.hasAudio,
    },
    assets: degraded
      ? { poster: `photos/${photo.id}/poster.webp`, lqip }
      : {
        src: `photos/${photo.id}/clip.mp4`,
        poster: `photos/${photo.id}/poster.webp`,
        lqip,
        ratio,
        duration: Number(duration.toFixed(2)),
      },
  };
}

/** 动图（GIF）：优先转成 MP4 循环；失败则原样复制，仍按动效对待 */
export async function convertAnimation(photo, distRoot, tmpDir) {
  const outDir = path.join(distRoot, 'photos', photo.id);
  await mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, 'clip.mp4');

  try {
    const info = await probeVideo(photo.srcPath);
    const { width, height } = targetSize(displayedSize(info));
    await run('ffmpeg', transcodeArgs({
      src: photo.srcPath, dest, width, height, crf: 24, hasAudio: false,
    }));
    const lqip = await makePoster(dest, outDir, Math.min(6, info.duration || 3), tmpDir);
    return {
      assets: { src: `photos/${photo.id}/clip.mp4`, poster: `photos/${photo.id}/poster.webp`, lqip },
      meta: { ratio: width / height, duration: Number(Math.min(6, info.duration || 0).toFixed(2)) },
    };
  } catch {
    const fallbackName = photo.ext === '.gif' ? 'anim.gif' : 'anim.webp';
    await copyFile(photo.srcPath, path.join(outDir, fallbackName));
    return {
      assets: { src: `photos/${photo.id}/${fallbackName}`, poster: `photos/${photo.id}/${fallbackName}` },
      meta: { ratio: 1, duration: 0 },
    };
  }
}
