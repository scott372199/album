import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { envInt } from '../lib/config.mjs';

/**
 * 视频处理：探测 → 转码 → 抽封面 → 脱敏复查。
 *
 * 关键顺序：先用 ffprobe 读 source 的 creation_time，再加 `-map_metadata -1`。
 * 反过来的话元数据先被清掉，拍摄时间就一起没了，照片会全部落到「不明年月」。
 *
 * Order matters: ffprobe the source for creation_time first, then transcode with
 * `-map_metadata -1`. Doing it the other way round wipes the capture date too.
 */

const execFileAsync = promisify(execFile);

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_SECONDS = 900;
const FPS = 30;

const FORBIDDEN_TAG_KEY = /location|gps|make$|model$|software|creation_time|com\.apple|artist|copyright|lens/i;

async function run(bin, args) {
  try {
    return await execFileAsync(bin, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim().split('\n').slice(-3).join(' | ') : err.message;
    throw new Error(`${bin} failed: ${detail}`);
  }
}

export async function probeVideo(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const data = JSON.parse(stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((item) => item.codec_type === 'video');
  const audio = streams.find((item) => item.codec_type === 'audio');
  if (!video) throw new Error('未找到视频流 / no video stream');

  const rotation = Number(
    video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation
    ?? video.tags?.rotate
    ?? 0,
  ) || 0;

  const duration = Number(data.format?.duration ?? video.duration ?? 0);

  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    rotation,
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: Boolean(audio),
    tags: data.format?.tags ?? {},
    streamTags: Object.assign({}, ...streams.map((item) => item.tags ?? {})),
    codec: video.codec_name,
  };
}

/**
 * 写进清单的时长只保留整数秒。
 *
 * 两个理由：一是前端角标只显示 m:ss，两位小数纯属噪声；二是浮点数会把
 * 清单哈希变得飘忽——同一段视频在不同 ffmpeg 版本下探测出 30.02 与 30.03，
 * 清单就换一个文件名，白白让所有客户端的缓存失效一次。
 *
 * 探测不到、或视频已降级成静图时返回 0，前端据此回退到纯 ▶ 角标；
 * 不足 1 秒的有效视频向上取到 1，避免「有画面但角标说 0」。
 *
 * Whole seconds only: the grid badge shows m:ss (two decimals are noise), and a
 * float makes the manifest hash wobble across ffmpeg versions, which would
 * needlessly bust every client's cache. 0 means "unknown" (degraded video or a
 * failed probe) so the frontend can fall back to a plain ▶; a real sub-second
 * clip rounds up to 1 rather than reporting 0.
 */
export function publicDuration(seconds, max = MAX_SOURCE_SECONDS) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.min(Math.round(value), max));
}

export function displayedSize({ width, height, rotation }) {
  const swapped = Math.abs(rotation) % 180 === 90;
  return swapped ? { width: height, height: width } : { width, height };
}

/**
 * 按短边封顶。「1080p」说的是短边 1080：横屏得到 1920×1080，竖屏得到
 * 1080×1920，两者都算 1080p。若按长边封顶，竖屏手机会被压到 608×1080，
 * 画质掉得莫名其妙。
 *
 * Caps the short edge: 1080p means a 1080 short edge, so landscape becomes
 * 1920×1080 and portrait 1080×1920. Capping the long edge instead would crush
 * portrait phone video to 608×1080.
 */
export function targetSize({ width, height }, shortEdgeCap) {
  const shortEdge = Math.min(width, height) || 1;
  const scale = Math.min(1, shortEdgeCap / shortEdge);
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

/** 拍摄时间必须在清元数据之前读出来 */
export function shotAtFrom(info) {
  const raw = info.tags['com.apple.quicktime.creationdate']
    || info.tags.creation_time
    || info.streamTags.creation_time;
  if (!raw) return null;
  const normalized = String(raw).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function transcodeArgs({ src, dest, width, height, crf, hasAudio }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-t', String(envInt('VIDEO_MAX_SECONDS', 30)),
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

/**
 * 转码后复查：容器与流上都不能留下任何可识别信息。
 * 这不是可选的洁癖——`-map_metadata -1` 只清容器级标签，某些封装仍会把
 * 编码器与设备信息留在流标签里，必须实测确认。
 *
 * Re-checks after transcode: `-map_metadata -1` only clears container tags, and
 * some muxers still leave encoder/device strings in stream tags.
 */
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
    throw new Error(`视频脱敏失败 / unsanitised tags: ${offenders.join(', ')}`);
  }
  return data;
}

async function grabPoster(clipPath, duration, tmpDir) {
  const frameFile = path.join(tmpDir, `poster-${Date.now()}.png`);
  // 取 0.3 倍处而不是第 0 帧：手机视频开头常常是黑的
  const seek = Math.min(1, Math.max(0, duration / 3));
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(seek), '-i', clipPath,
    '-frames:v', '1', frameFile,
  ]);

  const buffer = await sharp(await readFile(frameFile))
    .resize({ width: 1280, withoutEnlargement: true })
    .webp({ quality: 76 })
    .toBuffer();
  await rm(frameFile, { force: true });

  const check = await sharp(buffer).metadata();
  if (check.exif) throw new Error('封面脱敏失败 / poster still carries EXIF');

  const lqipBuffer = await sharp(buffer).resize({ width: 24 }).webp({ quality: 40 }).toBuffer();
  return {
    poster: buffer,
    lqip: `data:image/webp;base64,${lqipBuffer.toString('base64')}`,
  };
}

/**
 * 返回 `{ degraded: true }` 表示只留封面按静图处理。
 * 三种情况会走到这里：源片超过 15 分钟、转码后仍然超过 20MB、
 * 或者根本认不出可用的视频流。宁可少一条动图，也不要往站点塞一个几百兆的文件。
 */
export async function processVideo({ srcPath, tmpDir, clipPath }) {
  const info = await probeVideo(srcPath);
  const videoShotAt = shotAtFrom(info);

  if (info.duration > MAX_SOURCE_SECONDS) {
    const poster = await grabPoster(srcPath, Math.min(info.duration, 4), tmpDir);
    return { degraded: true, reason: 'source_too_long', videoShotAt, ...poster, duration: 0, ratio: 1 };
  }

  const displayed = displayedSize(info);
  const size = targetSize(displayed, envInt('VIDEO_MAX_HEIGHT', 1080));
  const ratio = displayed.height ? Number((displayed.width / displayed.height).toFixed(4)) : 1;

  await run('ffmpeg', transcodeArgs({
    src: srcPath,
    dest: clipPath,
    width: size.width,
    height: size.height,
    crf: 23,
    hasAudio: info.hasAudio,
  }));

  let bytes = (await stat(clipPath)).size;
  if (bytes > MAX_BYTES) {
    // 第一轮画质优先；超了就用更高的 CRF 再压一次，而不是直接放弃
    await run('ffmpeg', transcodeArgs({
      src: srcPath,
      dest: clipPath,
      width: size.width,
      height: size.height,
      crf: 28,
      hasAudio: info.hasAudio,
    }));
    bytes = (await stat(clipPath)).size;
  }

  if (bytes > MAX_BYTES) {
    await rm(clipPath, { force: true });
    const poster = await grabPoster(srcPath, Math.min(info.duration, 4), tmpDir);
    return { degraded: true, reason: 'output_too_large', videoShotAt, ...poster, duration: 0, ratio };
  }

  const clean = await assertCleanVideo(clipPath);
  const duration = Math.min(Number(clean.duration || info.duration), envInt('VIDEO_MAX_SECONDS', 30));
  const poster = await grabPoster(clipPath, duration, tmpDir);

  return {
    degraded: false,
    videoShotAt,
    clip: await readFile(clipPath),
    poster: poster.poster,
    lqip: poster.lqip,
    duration: publicDuration(duration),
    ratio,
    bytes,
    width: size.width,
    height: size.height,
  };
}
