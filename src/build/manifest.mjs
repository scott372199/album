import { readFile } from 'node:fs/promises';

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 可选的 photos/tags.csv：key,tags(| 分隔),title,caption */
export async function loadTagOverrides(tagsPath) {
  let text;
  try {
    text = await readFile(tagsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (!lines.length) return new Map();

  const first = splitCsvLine(lines[0]);
  const hasHeader = /^(key|id|path|文件|文件名)$/i.test(first[0]);
  const rows = hasHeader ? lines.slice(1) : lines;
  const overrides = new Map();

  for (const line of rows) {
    const [key, tags, title, caption] = splitCsvLine(line);
    if (!key) continue;
    overrides.set(key, {
      tags: tags ? tags.split('|').map((t) => t.trim()).filter(Boolean) : [],
      title: title || '',
      caption: caption || '',
    });
  }
  return overrides;
}

/** 按类型写出白名单字段，顺序固定，保证 manifest 字节稳定 */
function photoRecord(entry, extra, isFeatured) {
  const tags = [...new Set([
    entry.album,
    String(entry.year),
    ...(extra.tags || []),
  ])].filter(Boolean);

  const base = {
    id: entry.id,
    type: entry.type,
    album: entry.album,
    year: entry.year,
    month: entry.month,
    tags,
    title: extra.title || '',
    caption: extra.caption || '',
    ratio: entry.assets.ratio ?? entry.meta.ratio ?? 1,
    lqip: entry.assets.lqip || '',
    featured: Boolean(isFeatured),
  };

  if (entry.type === 'video') {
    Object.assign(base, {
      poster: entry.assets.poster,
      src: entry.assets.src,
      duration: entry.assets.duration,
    });
  } else if (entry.type === 'live') {
    Object.assign(base, {
      thumb: entry.assets.thumb,
      grid: entry.assets.grid,
      view: entry.assets.view,
      poster: entry.assets.poster,
      src: entry.assets.src,
      duration: entry.assets.duration,
    });
  } else if (entry.type === 'animation') {
    Object.assign(base, { poster: entry.assets.poster, src: entry.assets.src });
  } else {
    Object.assign(base, {
      thumb: entry.assets.thumb,
      grid: entry.assets.grid,
      view: entry.assets.view,
    });
  }

  // 去掉值为 undefined 的可选字段（例如降级后的 live 没有 src）
  for (const key of Object.keys(base)) {
    if (base[key] === undefined) delete base[key];
  }
  return base;
}

/**
 * 生成 manifest。字段严格白名单：
 * 不含原始文件名、源路径、GPS、序列号、拍摄具体时刻、EXIF 原文。
 */
export function buildManifest({ entries, site, overrides, hero, featured }) {
  const photos = entries.map((entry) => {
    const extra = overrides.get(entry.id) || overrides.get(entry.rel) || {};
    return photoRecord(entry, extra, featured.has(entry.id));
  });

  photos.sort((a, b) => b.year - a.year || b.month - a.month || a.id.localeCompare(b.id));

  const albumMap = new Map();
  for (const photo of photos) {
    if (!albumMap.has(photo.album)) {
      // photos 已按时间倒序，首次出现即该相册最新的一条
      albumMap.set(photo.album, {
        name: photo.album,
        count: 0,
        cover: photo.id,
        coverType: photo.type,
      });
    }
    albumMap.get(photo.album).count += 1;
  }

  // 不写入构建时间戳：manifest 内容必须稳定，否则内容哈希每次构建都会变化，
  // 会让「未变化文件跳过上传」失效。
  return {
    site: { title: site.title, subtitle: site.subtitle },
    hero: hero || '',
    photos,
    albums: [...albumMap.values()],
  };
}
