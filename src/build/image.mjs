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

const TIERS = [
  { name: 'thumb.webp', width: 320, height: null, quality: 70 },
  { name: 'grid.webp', width: 768, height: null, quality: 76 },
  { name: 'view.webp', width: 2048, height: 2048, quality: 82 },
];

/**
 * 生成脱敏的三档展示图与 LQIP 占位。
 * 关键：不调用 .withMetadata()，sharp 重新编码后 EXIF 全部消失，
 * 这是 spec FR-02 / FR-18「源头脱敏」的实现点。
 */
export async function processImage(photo, distRoot, tmpDir) {
  const outDir = path.join(distRoot, 'photos', photo.id);
  await mkdir(outDir, { recursive: true });

  const input = await prepareInput(photo.srcPath, photo.ext, tmpDir);
  const sourceMeta = await sharp(input).metadata();
  const ratio = sourceMeta.width && sourceMeta.height
    ? Number((sourceMeta.width / sourceMeta.height).toFixed(4))
    : 1;

  const pipeline = () => sharp(input, { animated: false }).rotate();
  const written = {};

  for (const tier of TIERS) {
    const file = path.join(outDir, tier.name);
    await pipeline()
      .resize({
        width: tier.width,
        height: tier.height ?? undefined,
        fit: tier.height ? 'inside' : 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: tier.quality })
      .toFile(file);

    // 脱敏断言：每一档都不得携带 EXIF
    const meta = await sharp(file).metadata();
    if (meta.exif) throw new Error(`脱敏失败：${file} 仍含 EXIF`);
    written[tier.name] = file;
  }

  // 24px 宽的模糊占位，内联进 manifest，避免首屏白块
  const lqipBuffer = await pipeline()
    .resize({ width: 24, withoutEnlargement: true })
    .webp({ quality: 40 })
    .toBuffer();
  const lqip = `data:image/webp;base64,${lqipBuffer.toString('base64')}`;

  return {
    thumb: `photos/${photo.id}/thumb.webp`,
    grid: `photos/${photo.id}/grid.webp`,
    view: `photos/${photo.id}/view.webp`,
    lqip,
    ratio,
  };
}
