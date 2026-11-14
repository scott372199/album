import { groupByYearMonth, computeEditorialRows, layoutParams } from './state.js';
import { escapeHtml, photoAlt, srcsetFor, sizesFor, isTouch, reducedMotion, markWhenReady } from './ui.js';

/* ---------- 视频瓦片：全局只允许 1 个在播 ---------- */
const media = { playing: null };

function stopPreview() {
  if (!media.playing) return;
  const { video } = media.playing;
  try { video.pause(); } catch { /* 忽略 */ }
  video.remove();
  media.playing = null;
}

function startPreview(tile, photo) {
  if (!photo.src || reducedMotion.matches) return;
  if (media.playing && media.playing.id === photo.id) return;
  stopPreview();

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.loop = photo.type !== 'live';
  video.preload = 'metadata';
  video.src = photo.src;
  video.className = 'tile-video';
  video.setAttribute('aria-hidden', 'true');
  tile.querySelector('.tile-frame')?.appendChild(video);

  const play = video.play();
  if (play && typeof play.catch === 'function') {
    play.then(() => { media.playing = { id: photo.id, video }; })
      .catch(() => { video.remove(); });
  } else {
    media.playing = { id: photo.id, video };
  }
}

function isMotion(photo) {
  return photo.type === 'video' || photo.type === 'live' || photo.type === 'animation';
}

/* ---------- 单个瓦片 ---------- */

function createTile(photo, { width, height, kind, onOpen, index }) {
  const tile = document.createElement('figure');
  tile.className = 'tile';
  tile.dataset.id = photo.id;
  tile.dataset.index = String(index);
  tile.style.width = `${width}px`;
  tile.style.height = `${height}px`;
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-label', photoAlt(photo));

  const frame = document.createElement('div');
  frame.className = 'tile-frame';
  if (photo.lqip) frame.style.backgroundImage = `url("${photo.lqip}")`;

  const img = document.createElement('img');
  img.alt = photoAlt(photo);
  img.loading = 'lazy';
  img.decoding = 'async';
  const srcset = srcsetFor(photo, kind);
  if (srcset) img.srcset = srcset;
  img.sizes = sizesFor(kind);
  img.src = kind === 'feature' ? (photo.view || photo.grid || photo.poster) : (photo.grid || photo.thumb || photo.poster);
  markWhenReady(img, img, 'is-loaded');

  frame.appendChild(img);
  tile.appendChild(frame);

  if (isMotion(photo)) {
    const badge = document.createElement('span');
    badge.className = 'tile-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = '▶';
    tile.appendChild(badge);
    if (!isTouch) {
      tile.addEventListener('pointerenter', () => startPreview(tile, photo));
      tile.addEventListener('pointerleave', stopPreview);
    }
  }

  const open = () => onOpen(index);
  tile.addEventListener('click', open);
  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  return tile;
}

/* ---------- 行与分组 ---------- */

const ratioOf = (photo) => Number(photo.ratio) || 1;

/**
 * 时间轴的纯布局计划。
 *
 * 「全量重排」与「逐批追加」两条路径都只消费这份计划，DOM 那层退化成照着计划
 * appendChild——于是两者是否等价，可以在 Node 里直接 deepEqual 比对，不需要浏览器
 * （本仓库没有 jsdom）。
 *
 * 计划里只放 id 与几何量、不放照片对象，它才能当「结构签名」用。
 *
 * The layout plan is plain data (ids + geometry). Both the full repaint and the
 * incremental append consume it, so their equivalence is assertable in Node
 * without a DOM.
 */
export function planCatalog(photos, width) {
  const params = layoutParams(width);
  const years = [];
  let offset = 0;

  for (const group of groupByYearMonth(photos)) {
    // 排版按整年连续进行：月份只作为吸顶标签，不再切断行，
    // 否则每月只剩一两张时每行都填不满，右侧会留下大片空白。
    const flat = [];
    const monthOf = new Map();
    const monthCount = new Map();
    for (const month of group.months) {
      for (const entry of month.items) {
        flat.push(entry.photo);
        monthOf.set(entry.photo.id, month.month);
      }
      // 月标题的张数在这里一次数完。原来每遇一个月标题就对整年 flat.filter 一遍，
      // 是 O(行数 × 照片数)；现在整年只走一遍。
      monthCount.set(month.month, month.items.length);
    }

    const rows = [];
    let currentMonth = null;
    for (const row of computeEditorialRows(flat, width, params)) {
      const month = monthOf.get(row.items[0].id);
      if (month !== currentMonth) {
        currentMonth = month;
        rows.push({ kind: 'month', month, count: monthCount.get(month) || 0 });
      }

      const feature = row.type === 'feature';
      const tiles = [];
      for (const photo of row.items) {
        const natural = row.height * ratioOf(photo);
        const tileWidth = feature ? Math.min(natural, width) : natural;
        tiles.push({
          id: photo.id,
          index: offset,
          width: tileWidth,
          height: feature ? Math.min(row.height, tileWidth / ratioOf(photo)) : row.height,
          kind: feature ? 'feature' : 'thumb',
        });
        offset += 1;
      }
      rows.push({ kind: 'row', type: row.type, height: row.height, tiles });
    }

    years.push({ year: group.year, total: flat.length, ids: flat.map((photo) => photo.id), rows });
  }

  return { width, params, years };
}

/**
 * 一年的结构签名：只要该年的照片序列没变，行布局就不会变——每年独立排版，
 * `computeEditorialRows` 的 `sinceFeature` 在年与年之间不传递（`plan.md` §4.2）。
 * 这是增量追加能成立的前提。
 */
export function yearKey(yearPlan) {
  return `${yearPlan.year}|${yearPlan.ids.join(',')}`;
}

/**
 * 把「已渲染的年」与「新的年计划」对齐：前缀完全相同的年份原样保留，
 * 从第一处不同起整段重建。
 *
 * 不假设「新照片一定排在后面」：日期倒序被打乱时（例如换了筛选条件）前缀会提前断开，
 * 那也只是多重建几年，结果依旧正确。
 */
export function diffYears(renderedKeys, plannedYears) {
  const max = Math.min(renderedKeys.length, plannedYears.length);
  let keep = 0;
  while (keep < max && renderedKeys[keep] === yearKey(plannedYears[keep])) keep += 1;
  return { keep, rebuild: plannedYears.slice(keep), stale: renderedKeys.length - keep };
}

function createRow(plan, { byId, onOpen }) {
  const node = document.createElement('div');
  node.className = `row row--${plan.type}`;
  node.style.height = `${plan.height}px`;

  for (const tile of plan.tiles) {
    const photo = byId.get(tile.id);
    // 计划与照片表对不上时宁可不画这一张，也不要抛异常把整页干掉
    if (!photo) continue;
    node.appendChild(createTile(photo, {
      width: tile.width,
      height: tile.height,
      kind: tile.kind,
      onOpen,
      index: tile.index,
    }));
  }

  // 大图行保持左对齐：整页共用一条左边线，比居中更稳
  return node;
}

function createYearSection(plan, { byId, onOpen }) {
  const section = document.createElement('section');
  section.className = 'year-group';

  const head = document.createElement('h2');
  head.className = 'year';
  head.innerHTML = `${plan.year}<span>${plan.total} 张</span>`;
  section.appendChild(head);

  const rowsHost = document.createElement('div');
  rowsHost.className = 'justified';
  for (const item of plan.rows) {
    if (item.kind === 'month') {
      const title = document.createElement('h3');
      title.className = 'month';
      title.innerHTML = `${item.month} 月<span>${item.count}</span>`;
      rowsHost.appendChild(title);
    } else {
      rowsHost.appendChild(createRow(item, { byId, onOpen }));
    }
  }

  section.appendChild(rowsHost);
  return section;
}

/**
 * 目录渲染器：时间轴（年 → 月 → 编辑式行）。
 * 分批：先渲染 limit 条，滚动到底再追加；重排按容器实测宽度重算。
 *
 * 增量：追加时只增删改动过的那几年，已经画好的年份一个节点都不碰；
 * 宽度变化、筛选重置这类「整页语义变了」的情况仍走全量重排。
 */
export function createCatalog({ container, onOpen, initialBatch = 60, chunk = 60 }) {
  let photos = [];
  let limit = initialBatch;
  let frame = null;
  let lastWidth = 0;
  let renderedKeys = [];
  let sections = [];

  function measure() {
    const width = container.clientWidth || 800;
    const params = layoutParams(width);
    // 让 CSS 的行间距与布局算法的 gap 完全一致，否则每行会短一截
    container.style.setProperty('--gap', `${params.gap}px`);
    return width;
  }

  function paintFull() {
    const width = measure();
    lastWidth = width;
    const visible = photos.slice(0, limit);
    const plan = planCatalog(visible, width);
    const byId = new Map(visible.map((photo) => [photo.id, photo]));
    const nodes = plan.years.map((yearPlan) => createYearSection(yearPlan, { byId, onOpen }));

    container.replaceChildren(...nodes);
    sections = nodes;
    renderedKeys = plan.years.map(yearKey);
    container.classList.add('is-ready');
  }

  /** 只重画从第一处变化起的那几年；其余年份的 DOM 原样留着 */
  function appendVisible() {
    const width = measure();
    lastWidth = width;
    const visible = photos.slice(0, limit);
    const plan = planCatalog(visible, width);
    const { keep, rebuild, stale } = diffYears(renderedKeys, plan.years);
    if (!rebuild.length && !stale) return; // 没有任何变化：一个节点都不碰

    const byId = new Map(visible.map((photo) => [photo.id, photo]));
    for (let i = keep; i < sections.length; i += 1) sections[i].remove();
    sections.length = keep;
    renderedKeys.length = keep;

    if (!rebuild.length) return;
    const fragment = document.createDocumentFragment();
    const appended = [];
    for (const yearPlan of rebuild) {
      const node = createYearSection(yearPlan, { byId, onOpen });
      fragment.appendChild(node);
      appended.push(node);
    }
    container.appendChild(fragment);
    sections.push(...appended);
    renderedKeys.push(...rebuild.map(yearKey));
    container.classList.add('is-ready');
  }

  function schedulePaint() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paintFull();
    });
  }

  const observer = new ResizeObserver(() => {
    // 追加内容会把容器撑高，ResizeObserver 因此会再响一次。只认宽度变化，
    // 否则每次 more() 都会被自己的高度变化打回全量重排，增量等于白做。
    if ((container.clientWidth || 800) === lastWidth) return;
    schedulePaint();
  });
  observer.observe(container);

  return {
    update(list, { reset = true } = {}) {
      photos = list;
      if (reset) limit = Math.min(initialBatch, list.length || initialBatch);
      paintFull();
    },
    more() {
      if (limit >= photos.length) return false;
      limit = Math.min(limit + chunk, photos.length);
      appendVisible();
      return true;
    },
    get hasMore() { return limit < photos.length; },
    destroy() { observer.disconnect(); },
  };
}

/* ---------- 精选 ---------- */

export function renderFeatured(host, photos, { onOpen }) {
  host.replaceChildren();
  if (!photos.length) return false;

  photos.slice(0, 4).forEach((photo, index) => {
    const block = document.createElement('figure');
    block.className = 'feature-block';
    block.classList.add(index % 2 ? 'is-right' : 'is-left');

    // 竖图不铺满整幅，否则一张图就吃掉一屏半；给它一个窄栏居中
    const ratio = Number(photo.ratio) || 1.5;
    if (ratio < 0.95) block.classList.add('is-portrait');

    const frame = document.createElement('div');
    frame.className = 'feature-frame';
    frame.style.aspectRatio = String(ratio);
    if (photo.lqip) frame.style.backgroundImage = `url("${photo.lqip}")`;

    const img = document.createElement('img');
    img.alt = photoAlt(photo);
    img.loading = index === 0 ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.src = photo.view || photo.grid || photo.poster;
    const srcset = srcsetFor(photo, 'feature');
    if (srcset) img.srcset = srcset;
    img.sizes = '100vw';
    markWhenReady(img, img, 'is-loaded');

    frame.appendChild(img);
    block.appendChild(frame);

    if (photo.title || photo.caption) {
      const caption = document.createElement('figcaption');
      caption.className = 'feature-caption';
      caption.innerHTML = `${escapeHtml(photo.title || '')}${photo.caption ? `<span>${escapeHtml(photo.caption)}</span>` : ''}`;
      block.appendChild(caption);
    }

    block.addEventListener('click', () => onOpen(photo));
    host.appendChild(block);
  });

  return true;
}

/* ---------- 相册卡片 ---------- */

export function renderAlbums(host, albums, { onOpenAlbum, byId }) {
  host.replaceChildren();
  for (const album of albums) {
    const cover = byId?.get(album.cover);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'album-card';

    const frame = document.createElement('div');
    frame.className = 'cover';
    if (cover?.lqip) frame.style.backgroundImage = `url("${cover.lqip}")`;
    if (cover) {
      const img = document.createElement('img');
      img.alt = `${album.name} 相册封面`;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = cover.view || cover.grid || cover.poster;
      markWhenReady(img, img, 'is-loaded');
      frame.appendChild(img);
    }

    const name = document.createElement('h3');
    name.textContent = album.name;
    const count = document.createElement('p');
    count.textContent = `${album.count} 张`;

    card.append(frame, name, count);
    card.addEventListener('click', () => onOpenAlbum(album.name));
    host.appendChild(card);
  }
}

export { stopPreview };
