import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

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
      if (!SUPPORTED.has(ext)) continue;
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

/**
 * 扫描源照片目录。
 * - 一级子目录名 = 相册；根目录照片归入「未分类」
 * - 源文件内容 SHA-256 前 12 位作为稳定 ID，内容相同只保留一份
 * - .albumignore 中列出的条目被跳过，不改动任何源文件
 * - 本模块不读 EXIF，也不向外暴露原始文件名之外的元数据
 */
export async function scanPhotos(photosDir) {
  const files = [];
  const ignoreRules = await loadIgnoreRules(photosDir);
  try {
    await walk(photosDir, '', files);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { photos: [], duplicates: [], ignored: [], scanned: 0 };
    }
    throw err;
  }

  const seen = new Set();
  const duplicates = [];
  const ignored = [];
  const photos = [];

  for (const file of files) {
    if (isIgnored(file.rel, ignoreRules)) {
      ignored.push(file.rel);
      continue;
    }

    const buffer = await readFile(file.srcPath);
    const id = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    if (seen.has(id)) {
      duplicates.push(file.rel);
      continue;
    }
    seen.add(id);

    const segments = file.rel.split(path.sep);
    const album = segments.length > 1 ? segments[0] : '未分类';
    const info = await stat(file.srcPath);

    photos.push({
      id,
      srcPath: file.srcPath,
      rel: file.rel,
      ext: file.ext,
      album,
      mtime: info.mtime,
      size: buffer.length,
    });
  }

  photos.sort((a, b) => a.rel.localeCompare(b.rel));
  return { photos, duplicates, ignored, scanned: files.length };
}
