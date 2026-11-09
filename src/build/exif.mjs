import exifr from 'exifr';

/**
 * 读取拍摄年月。
 * 只返回 year / month —— 不保留具体日期、时刻、时区、GPS、机身信息，
 * 以满足 spec FR-02 的字段白名单要求。
 * 无 EXIF 或解析失败时用文件 mtime 兜底，并标记 fallback。
 */
export async function readTakenAt(srcPath, mtime) {
  let date = null;

  try {
    const exif = await exifr.parse(srcPath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized'],
    });
    const raw = exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.DateTimeDigitized;

    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      date = raw;
    } else if (typeof raw === 'string') {
      // EXIF 常见格式："2024:04:05 10:23:00"
      const match = raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
      if (match) {
        date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      }
    }
  } catch {
    // 无 EXIF / 不受支持的格式（如 HEIC）→ 走兜底
  }

  const fallback = !date;
  const effective = date ?? mtime;
  return {
    year: effective.getFullYear(),
    month: effective.getMonth() + 1,
    fallback,
  };
}
