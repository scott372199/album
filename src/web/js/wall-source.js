/**
 * 照片墙的播放源与队列（V6 T-25）。
 *
 * 四源互斥：全部 / 精选 / 某一年 / 某相册。互斥不是「界面上让你选一个」，
 * 而是**池子只有一个**——`sourcePool` 返回一份数组，后面的队列、去重、停留
 * 时长全在这份数组上算，所以不存在「切换后混进上一源的照片」这种可能。
 *
 * 另外三条规则在这里落地（全部是纯函数，便于钉死）：
 *
 * 1. **视频不排等时定时器**。以前视频也走 `interval` 定时器，间隔比片长短时
 *    就会在放到一半被切走。现在视频只等 `ended`，另有一个 45 秒的安全上限，
 *    防止片子卡死不推进。
 * 2. **人像多停 1.5 秒**。有人脸的画面信息量大，一眼扫完就切走太浪费。
 * 3. **连拍近似只播一张**。用 `lqip`（24 px 指纹）当判据：同一张月内出现两次
 *    相同的 lqip，就认为画面几乎一样，只留第一张。判据弱，但**不猜**——
 *    lqip 缺失的条目一律不参与合并，宁可多播一张，也不把不同照片误删。
 *
 * Four mutually exclusive sources backed by a single pool, plus three rules:
 * videos never get a fixed-dwell timer (only `ended` plus a 45 s safety cap),
 * portraits hold 1.5 s longer, and near-identical burst shots collapse by LQIP
 * fingerprint — but only when an LQIP exists, so nothing is merged on a guess.
 */

export const VIDEO_SAFETY_MS = 45000;
export const PORTRAIT_HOLD_MS = 1500;
export const MIN_PHOTO_MS = 3000;
/** lqip 短于此长度就不当作指纹用（空串、占位符都算没有） */
const MIN_LQIP_LENGTH = 32;

export function isMotion(photo) {
  return Boolean(photo)
    && (photo.type === 'video' || photo.type === 'live' || photo.type === 'animation')
    && Boolean(photo.src);
}

/* ---------- 播放源 ---------- */

export function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2199) return '';
  return String(year);
}

/** `all` / `picks` / `year:2026` / `album:海边` → `{ kind, value }`；认不出就回 all */
export function parseSource(token) {
  const text = String(token || '').trim();
  if (text === 'picks') return { kind: 'picks', value: '' };
  if (text.startsWith('year:')) {
    const year = normalizeYear(text.slice(5));
    if (year) return { kind: 'year', value: year };
  }
  if (text.startsWith('album:')) {
    const album = text.slice(6).trim();
    if (album) return { kind: 'album', value: album };
  }
  return { kind: 'all', value: '' };
}

export function sourceToken(source) {
  const kind = source?.kind;
  if (kind === 'picks') return 'picks';
  if (kind === 'year' && normalizeYear(source.value)) return `year:${normalizeYear(source.value)}`;
  if (kind === 'album' && String(source.value || '').trim()) return `album:${String(source.value).trim()}`;
  return 'all';
}

/**
 * 下拉框里放哪些源。年份按清单里的顺序（已倒序），相册按条目数降序、
 * 同数按名字码位排——不用 `localeCompare`，产物要可复现。
 */
export function sourceOptions(photos, { picks = true } = {}) {
  const list = Array.isArray(photos) ? photos : [];
  const years = [...new Set(list.map((photo) => normalizeYear(photo?.year)).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
  const counts = new Map();
  for (const photo of list) {
    const album = String(photo?.album || '').trim();
    if (!album) continue;
    counts.set(album, (counts.get(album) || 0) + 1);
  }
  const albums = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name]) => name);

  const options = [{ token: 'all', label: '全部', count: list.length }];
  if (picks) options.push({ token: 'picks', label: '精选', count: 0 });
  for (const year of years) {
    options.push({
      token: `year:${year}`,
      label: `${year} 年`,
      count: list.filter((photo) => normalizeYear(photo?.year) === year).length,
    });
  }
  for (const album of albums) {
    options.push({
      token: `album:${album}`,
      label: album,
      count: counts.get(album),
    });
  }
  return options;
}

/**
 * 取池子。`fallback` 为真表示「要的源没有料，退回了全部」——调用方据此给一句
 * 提示，而不是默默放点别的照片装作一切正常。
 *
 * 精选来自 T-22 的策展产物；产物还没生成时 `picks` 是空数组，此时回退全部。
 */
export function sourcePool(photos, source, { picks = null } = {}) {
  const list = Array.isArray(photos) ? photos : [];
  const kind = source?.kind || 'all';

  if (kind === 'picks') {
    const ids = Array.isArray(picks) ? picks.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean) : [];
    if (!ids.length) return { photos: list, fallback: true, reason: 'picks-empty', source: { kind: 'all', value: '' } };
    const wanted = new Set(ids);
    const picked = list.filter((photo) => wanted.has(photo?.id));
    // 策展产物里的 id 全部失效（比如照片被删了）也要回退，而不是播一片空白
    if (!picked.length) return { photos: list, fallback: true, reason: 'picks-stale', source: { kind: 'all', value: '' } };
    return { photos: picked, fallback: false, reason: '', source };
  }

  if (kind === 'year') {
    const year = normalizeYear(source.value);
    const pool = list.filter((photo) => normalizeYear(photo?.year) === year);
    if (!pool.length) return { photos: list, fallback: true, reason: 'year-empty', source: { kind: 'all', value: '' } };
    return { photos: pool, fallback: false, reason: '', source };
  }

  if (kind === 'album') {
    const album = String(source.value || '').trim();
    const pool = list.filter((photo) => String(photo?.album || '').trim() === album);
    if (!pool.length) return { photos: list, fallback: true, reason: 'album-empty', source: { kind: 'all', value: '' } };
    return { photos: pool, fallback: false, reason: '', source };
  }

  return { photos: list, fallback: false, reason: '', source: { kind: 'all', value: '' } };
}

/* ---------- 队列 ---------- */

/**
 * 连拍近似合并。判据只有一条：**同一个 lqip 在同一轮里出现第二次**。
 * lqip 是 24 px 的指纹，两张几乎一样的连拍会给出同样的串；判据弱，所以只在
 * lqip 存在时生效——没有 lqip 的条目一律保留，不猜。
 */
export function dedupeBurst(photos) {
  const list = Array.isArray(photos) ? photos : [];
  const seen = new Set();
  const out = [];
  for (const photo of list) {
    const lqip = typeof photo?.lqip === 'string' ? photo.lqip.trim() : '';
    if (lqip.length >= MIN_LQIP_LENGTH) {
      const key = `${normalizeYear(photo?.year)}-${photo?.month}-${lqip}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(photo);
  }
  return out;
}

/**
 * 一轮的播放顺序：先「往年同月」，再「最近 24 张」，其余洗牌补齐。
 * 往年同月放在最前面是有意的——照片墙是拿来重温的，今天几号就该先看到
 * 往年这个月的照片。`shuffle` 由调用方注入，测试里换成恒等函数。
 */
export function buildQueue(photos, { now = new Date(), shuffle = (list) => list } = {}) {
  const list = dedupeBurst(Array.isArray(photos) ? photos : []);
  if (!list.length) return [];
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const sameMonth = list.filter((photo) => photo.month === month && photo.year < year);
  const recent = list.slice(0, 24);
  const seen = new Set([...sameMonth.map((photo) => photo.id), ...recent.map((photo) => photo.id)]);
  const rest = shuffle(list.filter((photo) => !seen.has(photo.id)));

  const out = [];
  const used = new Set();
  for (const photo of [...sameMonth.slice(0, 8), ...recent, ...rest]) {
    if (!photo || used.has(photo.id)) continue;
    used.add(photo.id);
    out.push(photo);
  }
  return out;
}

/**
 * 这张该停多久。视频返回 0——**0 就是「不要排等时定时器」**，由 `ended` 推进；
 * 调用方拿到 0 时改用 `VIDEO_SAFETY_MS` 兜底。
 */
export function dwellMs(photo, { interval = 10, portrait = false } = {}) {
  if (isMotion(photo)) return 0;
  const base = Math.max(MIN_PHOTO_MS, (Number(interval) || 10) * 1000);
  return base + (portrait ? PORTRAIT_HOLD_MS : 0);
}

/** 索引里的识别标签 → 有人像的 id 集合。索引缺失时是空集合，不影响播放 */
export function portraitIds(items) {
  const ids = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id) continue;
    for (const label of item.labels || []) {
      const term = String(label?.term || '').toLowerCase();
      if (term === 'person' || term === 'people') { ids.add(item.id); break; }
    }
  }
  return ids;
}
