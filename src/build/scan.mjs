import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const ANIMATION_EXT = new Set(['.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v']);
const ALL_EXT = new Set([...IMAGE_EXT, ...ANIMATION_EXT, ...VIDEO_EXT]);

async function walk(dir, relBase, out) {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const full = path.join(dir, item.name);
    const rel = relBase ? path.join(relBase, item.name) : item.name;
    if (item.isDirectory()) {
      await walk(full, rel, out);
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      if (!ALL_EXT.has(ext)) continue;
      out.push({ srcPath: full, rel, ext });
    }
  }
}

/** photos/.albumignore：每行一个相对路径、目录前缀或纯文件名，# 开头为注释 */
async function loadIgnoreRules(photosDir) {
  let text;
  try {
    text = await readFile(path.join(photosDir, '.albumignore'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function isIgnored(rel, rules) {
  const normalized = rel.split(path.sep).join('/');
  const basename = path.basename(rel);
  return rules.some((rule) => {
    if (rule.includes('/')) {
      return normalized === rule || normalized.startsWith(`${rule.replace(/\/$/, '')}/`);
    }
    return basename === rule;
  });
}

/** 流式哈希：视频动辄上百 MB，不要把整段读进内存 */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function albumOf(rel) {
  const segments = rel.split(path.sep);
  return segments.length > 1 ? segments[0] : '未分类';
}

/**
 * 扫描源素材目录。
 * - 一级子目录名 = 相册；根目录素材归入「未分类」
 * - 图片与视频走同一套去重与排序
 * - 同目录同名的「图片 + MOV」视为 Live Photo，合成一条内容
 * - .albumignore 命中的文件（含视频）整体跳过，不改动源文件
 * - 本模块不读 EXIF，只产出内容哈希与结构信息
 */
export async function scanPhotos(photosDir) {
  const files = [];
  const ignoreRules = await loadIgnoreRules(photosDir);
  try {
    await walk(photosDir, '', files);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { photos: [], duplicates: [], ignored: [], scanned: 0, livePairs: 0 };
    }
    throw err;
  }

  const ignored = [];
  const kept = [];
  for (const file of files) {
    if (isIgnored(file.rel, ignoreRules)) ignored.push(file.rel);
    else kept.push(file);
  }

  // 按「目录 + 无扩展名文件名」分组，找 Live Photo 配对
  const groups = new Map();
  for (const file of kept) {
    const key = path.join(path.dirname(file.rel), path.basename(file.rel, file.ext));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  const seen = new Set();
  const duplicates = [];
  const photos = [];
  let livePairs = 0;

  for (const group of groups.values()) {
    group.sort((a, b) => a.ext.localeCompare(b.ext));
    const image = group.find((f) => IMAGE_EXT.has(f.ext) || ANIMATION_EXT.has(f.ext));
    const video = group.find((f) => VIDEO_EXT.has(f.ext));

    // 同名图片 + 视频 → Live Photo；否则各自独立成条
    const items = image && video
      ? [{ ...image, companion: video, type: 'live' }]
      : [
        ...(image ? [{
          ...image,
          companion: null,
          type: ANIMATION_EXT.has(image.ext) ? 'animation' : 'image',
        }] : []),
        ...(video ? [{ ...video, companion: null, type: 'video' }] : []),
      ];

    for (const item of items) {
      const mainHash = await hashFile(item.srcPath);
      // 单文件条目沿用 v2 的「内容哈希前 12 位」，保证分享链接与产物目录跨版本稳定；
      // Live Photo 需要把两个文件一起纳入哈希，否则任一侧改动不会换 id。
      const id = item.companion
        ? createHash('sha256')
          .update(mainHash + await hashFile(item.companion.srcPath))
          .digest('hex')
          .slice(0, 12)
        : mainHash.slice(0, 12);

      if (seen.has(id)) {
        duplicates.push(item.rel);
        continue;
      }
      seen.add(id);

      const info = await stat(item.srcPath);
      const companionInfo = item.companion ? await stat(item.companion.srcPath) : null;

      photos.push({
        id,
        type: item.type,
        srcPath: item.srcPath,
        videoPath: item.companion ? item.companion.srcPath : null,
        rel: item.rel,
        ext: item.ext,
        album: albumOf(item.rel),
        mtime: info.mtime,
        size: info.size + (companionInfo ? companionInfo.size : 0),
      });

      if (item.type === 'live') livePairs += 1;
    }
  }

  photos.sort((a, b) => a.rel.localeCompare(b.rel));
  return { photos, duplicates, ignored, scanned: files.length, livePairs };
}
