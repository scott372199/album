/** 轻量 DOM / 格式化工具，只被前端组件使用。 */

export const el = (id) => document.getElementById(id);

export const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: true };

export const isTouch = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: none)').matches;

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

let toastTimer = null;
export function toast(message, ms = 2400) {
  const node = el('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), ms);
}

export function photoAlt(photo) {
  if (photo.title) return photo.title;
  const date = `${photo.year} 年 ${photo.month} 月`;
  // 相册名就是年份时（根目录照片会归到年份相册），不要重复一遍年份
  return photo.album && photo.album !== String(photo.year) ? `${photo.album} · ${date}` : date;
}

/** 视频类内容也先拿封面当图用 */
export function posterOf(photo) {
  return photo.view || photo.poster || '';
}

export function thumbOf(photo) {
  return photo.thumb || photo.poster || '';
}

/**
 * 媒体就绪后给目标节点加类名。
 * 图片可能已在缓存中（complete 为 true）而不再触发 load，必须当场判定，
 * 否则图层会永远停在 opacity: 0。
 */
export function markWhenReady(media, target, cls = 'is-ready') {
  if (!media || !target) return;
  const done = () => target.classList.add(cls);
  if (media.tagName === 'VIDEO') {
    if (media.readyState >= 2) done();
    else {
      media.addEventListener('loadeddata', done, { once: true });
      media.addEventListener('error', done, { once: true });
    }
    return;
  }
  if (media.complete && media.naturalWidth > 0) {
    done();
    return;
  }
  media.addEventListener('load', done, { once: true });
  media.addEventListener('error', done, { once: true });
}

export function srcsetFor(photo, kind) {
  if (kind === 'thumb') {
    const set = [];
    if (photo.thumb) set.push(`${photo.thumb} 320w`);
    if (photo.grid) set.push(`${photo.grid} 768w`);
    return set.join(', ');
  }
  if (kind === 'feature') {
    const set = [];
    if (photo.grid) set.push(`${photo.grid} 768w`);
    if (photo.view) set.push(`${photo.view} 2048w`);
    return set.join(', ');
  }
  const set = [];
  if (photo.thumb) set.push(`${photo.thumb} 320w`);
  if (photo.grid) set.push(`${photo.grid} 768w`);
  return set.join(', ');
}

export function sizesFor(kind) {
  if (kind === 'feature') return '100vw';
  if (kind === 'thumb') return '(max-width: 768px) 30vw, 3.4vw';
  return '(max-width: 768px) 46vw, (max-width: 1200px) 31vw, 470px';
}

export function formatSpan(photos) {
  if (!photos.length) return '—';
  const years = photos.map((p) => p.year);
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? `${min}` : `${min}–${max}`;
}

export function monthLabel(month) {
  return `${month} 月`;
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function clockParts(date = new Date()) {
  return {
    time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
    date: `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`,
    weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()],
  };
}

/** 照片墙的夜间时段判断，支持跨零点 */
export function inNightWindow(now, from, to) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = String(from).split(':').map(Number);
  const [th, tm] = String(to).split(':').map(Number);
  const start = fh * 60 + fm;
  const end = th * 60 + tm;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/** 均匀洗牌，避免同一批总以相同顺序出现 */
export function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
