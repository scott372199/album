/**
 * 上传归位建议（V6 T-27）。
 *
 * 选完照片、还没开始传的那一下，猜一个相册名 + 几个标签，让用户一键采纳或
 * 直接忽略。三条规矩：
 *
 * 1. **纯内存**。只读三样东西：文件的 `lastModified`、清单里的既有相册名、
 *    语义索引里的标签。不发请求、不写对象、不改任何数据——采纳只是把值填进
 *    输入框，之后走的还是原来那条上传路径。
 * 2. **只给建议，不替用户决定**。用户自己动过相册名就不再建议；不采纳时
 *    流程与以前完全一样。
 * 3. **时间是「文件时间」，不是拍摄时间**。前端拿不到 EXIF（HEIC 尤其拿不到），
 *    所以这里用的是 `lastModified`，只当**同批文件的聚集信号**——照片从相机
 *    导出后 mtime 通常同批接近。真正的年月仍由服务端从元数据判定，所以这个
 *    猜测**永远不会成为事实来源**。
 *
 * In-memory suggestions only: reads file mtimes, existing album names and index
 * labels, writes nothing. The clock is `lastModified` (no client-side EXIF), used
 * purely as a "these files belong together" signal — the server still decides
 * year/month from metadata, so this guess never becomes the source of truth.
 */

const CJK = /[\u4e00-\u9fa5]/;
export const MAX_SUGGESTED_TAGS = 5;
export const MIN_SUGGESTED_TAGS = 3;

const TAG_KINDS = new Set(['object', 'scene']);

/** 文件时间；认不出就给 null，绝不拿 `Date.now()` 冒充 */
export function fileClock(file) {
  const value = Number(file?.lastModified);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * 一批文件里最集中的那个月。按 UTC+8 换算——和 `resolveYearMonth` 用的是同一
 * 个时区约定，否则「11 月 1 日清晨」在建议里会落到 10 月。
 */
export function dominantMonth(files) {
  const counts = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const clock = fileClock(file);
    if (clock === null) continue;
    const shifted = new Date(clock + 8 * 3600 * 1000);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() + 1;
    if (year < 1900 || year > 2199) continue;
    const key = `${year}-${month}`;
    const entry = counts.get(key) || { year, month, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  if (!counts.size) return null;
  return [...counts.values()]
    .sort((a, b) => (b.count - a.count) || (b.year - a.year) || (b.month - a.month))[0];
}

/**
 * 从既有相册名里认命名模式。认出「2026」「2026-11」「2026 年 11 月」这类模式后
 * 按同样的形状造一个新名字，用户翻相册时不会突然混进一种陌生写法。
 */
export function albumPattern(albums) {
  const list = (Array.isArray(albums) ? albums : []).map((name) => String(name || '').trim()).filter(Boolean);
  const patterns = [
    { id: 'year-month-cn', test: /^\d{4} 年 \d{1,2} 月$/, build: (y, m) => `${y} 年 ${m} 月` },
    { id: 'year-cn', test: /^\d{4} 年$/, build: (y) => `${y} 年` },
    { id: 'year-month-dash', test: /^\d{4}-\d{2}$/, build: (y, m) => `${y}-${String(m).padStart(2, '0')}` },
    { id: 'year', test: /^\d{4}$/, build: (y) => String(y) },
  ];
  for (const pattern of patterns) {
    const hits = list.filter((name) => pattern.test.test(name));
    if (hits.length) return { ...pattern, hits: hits.length };
  }
  return null;
}

/**
 * 相册名建议：先看「这批照片的月份有没有现成的相册」，再看既有命名模式，
 * 最后退回年份——也就是上传面板原本的默认值，所以最差情况不会更差。
 */
export function suggestAlbum({ month, albums = [] } = {}) {
  const list = (Array.isArray(albums) ? albums : []).map((name) => String(name || '').trim()).filter(Boolean);
  const year = Number(month?.year);
  const key = Number(month?.month);
  if (!Number.isInteger(year) || year < 1900 || year > 2199) {
    const fallback = String(new Date().getFullYear());
    return list.includes(fallback)
      ? { name: fallback, reason: 'reuse-year', exists: true }
      : { name: fallback, reason: 'default-year', exists: false };
  }

  const pattern = albumPattern(list);
  const candidates = [];
  if (pattern) candidates.push(pattern.build(year, key));
  candidates.push(String(year), `${year} 年`, `${year}-${String(key).padStart(2, '0')}`, `${year} 年 ${key} 月`);

  for (const name of candidates) {
    if (!name) continue;
    if (list.includes(name)) return { name, reason: 'reuse-existing', exists: true };
  }
  const built = pattern ? pattern.build(year, key) : String(year);
  return { name: built, reason: pattern ? `pattern:${pattern.id}` : 'year', exists: false };
}

/**
 * 标签建议：先取同月的标签，不够三个就放宽到同年。
 *
 * 只收有中文的「东西 / 场景」标签——颜色另有归处，未翻译的词摆出来像没做完。
 * 相册名本身也会变成一个标签，所以从建议里剔掉，免得同一句话说两遍。
 */
export function suggestTags({ month, items = [], albumName = '', limit = MAX_SUGGESTED_TAGS } = {}) {
  const year = Number(month?.year);
  const key = Number(month?.month);
  const list = Array.isArray(items) ? items : [];
  const exclude = new Set([String(albumName || '').trim(), String(year)]);

  const collect = (filter) => {
    const counter = new Map();
    for (const item of list) {
      if (!item || !filter(item)) continue;
      const seen = new Set();
      for (const label of item.labels || []) {
        if (!label || !TAG_KINDS.has(label.kind)) continue;
        const zh = String(label.zh || '').trim();
        if (!zh || !CJK.test(zh) || exclude.has(zh) || seen.has(zh)) continue;
        seen.add(zh);
        const entry = counter.get(zh) || { zh, count: 0 };
        entry.count += 1;
        counter.set(zh, entry);
      }
    }
    return [...counter.values()].sort((a, b) => (b.count - a.count) || (a.zh < b.zh ? -1 : a.zh > b.zh ? 1 : 0));
  };

  const sameMonth = collect((item) => item.year === year && item.month === key);
  if (sameMonth.length >= MIN_SUGGESTED_TAGS) return sameMonth.slice(0, limit);
  const sameYear = collect((item) => item.year === year);
  const merged = [...sameMonth];
  for (const tag of sameYear) {
    if (merged.length >= limit) break;
    if (!merged.some((item) => item.zh === tag.zh)) merged.push(tag);
  }
  return merged.slice(0, limit);
}

/**
 * 打包成一条建议。`files` 少于 2 个时不给建议——单张照片谈不上「归位」，
 * 打扰大于帮助。
 */
export function buildSuggestion({ files, albums = [], items = [], minFiles = 2 } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (list.length < minFiles) return null;
  const month = dominantMonth(list);
  if (!month) return null;

  const album = suggestAlbum({ month, albums });
  const tags = suggestTags({ month, items, albumName: album.name });

  // 相册名没变化、标签也凑不出来，就没有什么可建议的
  if (album.reason === 'reuse-existing' && tags.length < MIN_SUGGESTED_TAGS) {
    return { month, album, tags, weak: true };
  }
  return { month, album, tags, weak: false };
}

/** 建议里那行说明：为什么是这个月、这批文件算不算同一批 */
export function suggestionNote(suggestion) {
  const month = suggestion?.month;
  if (!month) return '';
  const album = suggestion.album;
  const span = album?.exists ? '已有这个相册' : '按现有的相册命名习惯';
  return `${month.count} 个文件落在 ${month.year} 年 ${month.month} 月 · ${span}`;
}
