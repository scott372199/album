import sharp from 'sharp';
import exifr from 'exifr';
import { envInt } from '../lib/config.mjs';

/**
 * 图片处理：三档 WebP + 内联占位。
 *
 * 这里是隐私的唯一防线：绝不调用 `.withMetadata()`，sharp 重新编码后原图的
 * EXIF（含 GPS、机身序列号、拍摄精确时刻）全部消失。每档产出后再读一次
 * metadata 断言没有 EXIF——不做这个断言，某天升级 sharp 的行为变化会
 * 悄无声息地把 GPS 带上云。
 *
 * The privacy boundary: `.withMetadata()` is never called, so sharp's
 * re-encode drops the original EXIF (GPS, body serial, exact capture time).
 * Each output is re-read to assert no EXIF survives — without that assertion a
 * future sharp behaviour change could silently ship GPS to the cloud.
 */

// 三档而不是两档：前端 srcset 会在 320/768/2048 之间挑，缺了 768 就得在
// 平板上直接拉 2048 的图，流量翻几倍。plan 里写的两档是笔误，这里按前端实际
// 需求产出三档。
// Three tiers, not two: the frontend's srcset picks between 320/768/2048, and
// without the 768 tier tablets would pull the 2048 image on every tile.
const GRID_WIDTH = 768;

function tiers() {
  return [
    { name: 'thumb.webp', width: envInt('THUMB_WIDTH', 320), quality: 70 },
    { name: 'grid.webp', width: GRID_WIDTH, quality: 76 },
    {
      name: 'view.webp',
      width: envInt('VIEW_MAX_EDGE', 2048),
      quality: envInt('VIEW_QUALITY', 82),
      square: true,
    },
  ];
}

/** orientation 5~8 表示要旋转 90/270，显示宽高与原图互换 */
export function displayedSize(meta) {
  const orientation = Number(meta?.orientation || 1);
  const swap = orientation >= 5 && orientation <= 8;
  const width = Number(meta?.width || 0);
  const height = Number(meta?.height || 0);
  return swap ? { width: height, height: width } : { width, height };
}

async function readShotAt(buffer) {
  try {
    const parsed = await exifr.parse(buffer, ['DateTimeOriginal', 'CreateDate']);
    const date = parsed?.DateTimeOriginal || parsed?.CreateDate;
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    // 没有 EXIF、或者格式不认识，都算「不知道拍摄时间」，不是错误
    return null;
  }
}

export async function processImage(buffer) {
  const meta = await sharp(buffer).metadata();
  const size = displayedSize(meta);
  const ratio = size.height ? Number((size.width / size.height).toFixed(4)) : 1;

  // .rotate() 无参 = 按 EXIF 正立；之后的 resize 作用于正立后的坐标系
  const pipeline = () => sharp(buffer, { animated: false }).rotate();

  const buffers = {};
  for (const tier of tiers()) {
    const output = await pipeline()
      .resize({
        width: tier.width,
        height: tier.square ? tier.width : undefined,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: tier.quality })
      .toBuffer();

    const check = await sharp(output).metadata();
    if (check.exif) {
      throw new Error(`脱敏失败 / EXIF survived re-encode: ${tier.name}`);
    }
    buffers[tier.name] = output;
  }

  // 24px 宽的模糊占位内联进清单，首屏不会先白一块
  const lqipBuffer = await pipeline()
    .resize({ width: 24, withoutEnlargement: true })
    .webp({ quality: 40 })
    .toBuffer();

  return {
    buffers,
    ratio,
    width: size.width,
    height: size.height,
    lqip: `data:image/webp;base64,${lqipBuffer.toString('base64')}`,
    // EXIF 里没有时区，DateTimeOriginal 是「相机上的墙上时间」。
    // 命名成 exifShotAt 是为了让调用方不敢把它当绝对时刻再换算时区。
    // EXIF carries no zone: DateTimeOriginal is the camera's wall clock. The
    // name warns callers not to treat it as an absolute instant.
    exifShotAt: await readShotAt(buffer),
  };
}
