import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

/**
 * HEIC 先转临时 JPEG。sharp 的预编译二进制通常不带 HEIC 解码器，
 * macOS 的 sips 是零依赖的可靠替代。
 */
async function prepareInput(srcPath, ext, tmpDir) {
  if (ext !== '.heic' && ext !== '.heif') return srcPath;
  const target = path.join(tmpDir, `${path.basename(srcPath)}.jpg`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', srcPath, '--out', target]);
  } catch (err) {
    throw new Error(`HEIC 转换失败（需要 macOS sips）：${srcPath} — ${err.message}`);
  }
  return target;
}

/**
 * 生成脱敏的缩略图与展示图。
 * 关键：不调用 .withMetadata()，sharp 重新编码后 EXIF 全部消失，
 * 这是 spec FR-02「源头脱敏」的实现点。
 */
export async function processImage(photo, distRoot, tmpDir) {
  const outDir = path.join(distRoot, 'photos', photo.id);
  await mkdir(outDir, { recursive: true });

  const input = await prepareInput(photo.srcPath, photo.ext, tmpDir);
  const thumbPath = path.join(outDir, 'thumb.webp');
  const viewPath = path.join(outDir, 'view.webp');

  const sourceMeta = await sharp(input).metadata();
  const ratio = sourceMeta.width && sourceMeta.height
    ? Number((sourceMeta.width / sourceMeta.height).toFixed(4))
    : 1;

  const pipeline = () => sharp(input).rotate();

  await pipeline()
    .resize({ width: 320, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toFile(thumbPath);

  await pipeline()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(viewPath);

  // 脱敏断言：输出文件不得携带任何 EXIF 块
  const outMeta = await sharp(viewPath).metadata();
  if (outMeta.exif) {
    throw new Error(`脱敏失败：${viewPath} 仍含 EXIF`);
  }

  return {
    thumb: `photos/${photo.id}/thumb.webp`,
    view: `photos/${photo.id}/view.webp`,
    ratio,
  };
}
