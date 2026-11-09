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

function createRow(row, { onOpen, offset, maxWidth }) {
  const node = document.createElement('div');
  node.className = `row row--${row.type}`;
  node.style.height = `${row.height}px`;

  let cursor = offset;
  row.items.forEach((photo) => {
    const natural = row.height * (Number(photo.ratio) || 1);
    const width = row.type === 'feature' ? Math.min(natural, maxWidth) : natural;
    const tile = createTile(photo, {
      width,
      height: row.type === 'feature' ? Math.min(row.height, width / (Number(photo.ratio) || 1)) : row.height,
      kind: row.type === 'feature' ? 'feature' : 'thumb',
      onOpen,
      index: cursor,
    });
    cursor += 1;
    node.appendChild(tile);
  });

  // 大图行保持左对齐：整页共用一条左边线，比居中更稳
  return node;
}

/**
 * 目录渲染器：时间轴（年 → 月 → 编辑式行）。
 * 分批：先渲染 limit 条，滚动到底再追加；重排按容器实测宽度重算。
 */
export function createCatalog({ container, onOpen, initialBatch = 60, chunk = 60 }) {
  let photos = [];
  let limit = initialBatch;
  let frame = null;

  function paint() {
    const width = container.clientWidth || 800;
    const params = layoutParams(width);
    // 让 CSS 的行间距与布局算法的 gap 完全一致，否则每行会短一截
    container.style.setProperty('--gap', `${params.gap}px`);
    const visible = photos.slice(0, limit);
    const fragment = document.createDocumentFragment();
    let offset = 0;

    for (const group of groupByYearMonth(visible)) {
      const section = document.createElement('section');
      section.className = 'year-group';

      const head = document.createElement('h2');
      head.className = 'year';
      const total = group.months.reduce((sum, month) => sum + month.items.length, 0);
      head.innerHTML = `${group.year}<span>${total} 张</span>`;
      section.appendChild(head);

      // 排版按整年连续进行：月份只作为吸顶标签，不再切断行，
      // 否则每月只剩一两张时每行都填不满，右侧会留下大片空白。
      const monthOf = new Map();
      const flat = [];
      for (const month of group.months) {
        for (const entry of month.items) {
          monthOf.set(entry.photo.id, month.month);
          flat.push(entry.photo);
        }
      }

      const rowsHost = document.createElement('div');
      rowsHost.className = 'justified';

      let currentMonth = null;
      for (const row of computeEditorialRows(flat, width, params)) {
        const rowMonth = monthOf.get(row.items[0].id);
        if (rowMonth !== currentMonth) {
          currentMonth = rowMonth;
          const title = document.createElement('h3');
          title.className = 'month';
          const count = flat.filter((photo) => monthOf.get(photo.id) === rowMonth).length;
          title.innerHTML = `${rowMonth} 月<span>${count}</span>`;
          rowsHost.appendChild(title);
        }
        rowsHost.appendChild(createRow(row, { onOpen, offset, maxWidth: width }));
        offset += row.items.length;
      }

      section.appendChild(rowsHost);
      fragment.appendChild(section);
    }

    container.replaceChildren(fragment);
    container.classList.add('is-ready');
  }

  function schedulePaint() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paint();
    });
  }

  const observer = new ResizeObserver(schedulePaint);
  observer.observe(container);

  return {
    update(list, { reset = true } = {}) {
      photos = list;
      if (reset) limit = Math.min(initialBatch, list.length || initialBatch);
      paint();
    },
    more() {
      if (limit >= photos.length) return false;
      limit = Math.min(limit + chunk, photos.length);
      paint();
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
