import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHOTOS = path.join(ROOT, 'photos');

const SPECS = [
  { album: '样例-京都', year: 2024, month: 4, w: 1600, h: 1200, c1: '#6b7f6e', c2: '#d8c9a8', label: '01', exif: true },
  { album: '样例-京都', year: 2024, month: 4, w: 1200, h: 1600, c1: '#8a6f5c', c2: '#e6d7c3', label: '02', exif: false },
  { album: '样例-京都', year: 2024, month: 5, w: 1800, h: 1200, c1: '#4f6d7a', c2: '#c9d8d3', label: '03', exif: false },
  { album: '样例-京都', year: 2024, month: 11, w: 1400, h: 1050, c1: '#9a6b55', c2: '#e8c9a8', label: '04', exif: true },
  { album: '样例-京都', year: 2024, month: 11, w: 1050, h: 1400, c1: '#5b6b8c', c2: '#cdd6e6', label: '05', exif: false },
  { album: '样例-日常', year: 2025, month: 1, w: 1600, h: 1067, c1: '#7a8b6f', c2: '#e3e0c9', label: '06', exif: false },
  { album: '样例-日常', year: 2025, month: 3, w: 1200, h: 1200, c1: '#a8786b', c2: '#eeddd0', label: '07', exif: false },
  { album: '样例-日常', year: 2025, month: 3, w: 1500, h: 1000, c1: '#6b7f8a', c2: '#d4e0e5', label: '08', exif: false },
  { album: '样例-日常', year: 2025, month: 8, w: 1000, h: 1500, c1: '#8c7a95', c2: '#e2d7e8', label: '09', exif: true },
  { album: '样例-日常', year: 2025, month: 8, w: 1600, h: 1200, c1: '#7f8f6a', c2: '#e0e5c8', label: '10', exif: false },
  { album: '样例-旅行', year: 2023, month: 7, w: 1920, h: 1280, c1: '#4d7c8a', c2: '#c4dde0', label: '11', exif: false },
  { album: '样例-旅行', year: 2023, month: 7, w: 1280, h: 1920, c1: '#8a7a5c', c2: '#e8dcc0', label: '12', exif: false },
  { album: '样例-旅行', year: 2023, month: 12, w: 1600, h: 1200, c1: '#6d6f8f', c2: '#d5d6e8', label: '13', exif: true },
  { album: '样例-旅行', year: 2026, month: 2, w: 1400, h: 933, c1: '#7f9a7a', c2: '#dbe7cf', label: '14', exif: false },
  { album: '样例-旅行', year: 2026, month: 2, w: 933, h: 1400, c1: '#9c7b70', c2: '#ecd9cf', label: '15', exif: false },
  { album: '样例-旅行', year: 2026, month: 6, w: 1800, h: 1200, c1: '#5c7d84', c2: '#cfe0dd', label: '16', exif: false },
];

function makeSvg(spec) {
  const size = Math.round(Math.min(spec.w, spec.h) / 6);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${spec.w}" height="${spec.h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="${spec.c1}"/><stop offset="1" stop-color="${spec.c2}"/>
  </linearGradient></defs>
  <rect width="${spec.w}" height="${spec.h}" fill="url(#g)"/>
  <text x="50%" y="50%" font-family="Arial" font-size="${size}" fill="rgba(255,255,255,0.82)"
        text-anchor="middle" dominant-baseline="middle">${spec.label}</text>
</svg>`);
}

/**
 * 手工构造标准 EXIF APP1 段，只含 ExifIFD 的 DateTimeOriginal (0x9003)。
 * sharp 的 withMetadata 不会写入这个字段，直接拼 APP1 才能验证 exifr 读取分支。
 */
function buildExifApp1(dateTimeOriginal) {
  const text = Buffer.from(`${dateTimeOriginal}\0`, 'ascii');
  const TIFF_SIZE = 44 + text.length;
  const tiff = Buffer.alloc(TIFF_SIZE);

  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);             // IFD0 起点

  tiff.writeUInt16LE(1, 8);             // IFD0 条目数
  tiff.writeUInt16LE(0x8769, 10);       // ExifIFDPointer
  tiff.writeUInt16LE(4, 12);            // LONG
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);           // 指向 ExifIFD
  tiff.writeUInt32LE(0, 22);            // 无下一个 IFD

  tiff.writeUInt16LE(1, 26);            // ExifIFD 条目数
  tiff.writeUInt16LE(0x9003, 28);       // DateTimeOriginal
  tiff.writeUInt16LE(2, 30);            // ASCII
  tiff.writeUInt32LE(text.length, 32);
  tiff.writeUInt32LE(44, 36);           // 指向字符串
  tiff.writeUInt32LE(0, 40);
  text.copy(tiff, 44);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

async function main() {
  console.log(`向 ${PHOTOS} 写入 ${SPECS.length} 张样例照片（仅用于本地验证，可随时删除）...`);
  let exifWritten = 0;

  for (let i = 0; i < SPECS.length; i += 1) {
    const spec = SPECS[i];
    const dir = path.join(PHOTOS, spec.album);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `IMG_${String(i + 1).padStart(4, '0')}.jpg`);
    const dateStr = `${spec.year}:${String(spec.month).padStart(2, '0')}:15 10:30:00`;

    const jpeg = await sharp(makeSvg(spec)).jpeg({ quality: 85 }).toBuffer();
    if (spec.exif) {
      const app1 = buildExifApp1(dateStr);
      await writeFile(file, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
      exifWritten += 1;
    } else {
      await writeFile(file, jpeg);
    }

    // 无 EXIF 的样例靠 mtime 兜底，这里设置不同年月
    const timestamp = new Date(spec.year, spec.month - 1, 15, 12, 0, 0);
    await utimes(file, timestamp, timestamp);
  }

  console.log(`完成：${SPECS.length} 张，其中 ${exifWritten} 张带 EXIF DateTimeOriginal，${SPECS.length - exifWritten} 张依赖 mtime 兜底。`);
  console.log('接下来运行：npm run build');
}

main().catch((err) => {
  console.error('样例生成失败：', err);
  process.exitCode = 1;
});
