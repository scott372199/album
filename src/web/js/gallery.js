import {
  groupByYearMonth, computeEditorialRows, layoutParams, normalizeDensity, albumSummary,
} from './state.js';
import { escapeHtml, photoAlt, srcsetFor, sizesFor, isTouch, reducedMotion, markWhenReady } from './ui.js';
import { badgeText, spokenDuration } from './duration.js';
import { pickPhotos, monthKeyOf } from './curation.js';

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

/** 一张图最多试 3 次，全部失败才出占位卡 / Three attempts before the placeholder */
const MAX_IMAGE_ATTEMPTS = 3;

/**
 * 同一张照片的候选源，按「想给的清晰度」排好序。
 * 大图行的首选 `view` 可能还没转出，退到 `grid` 仍然好看；
 * 网格本来就在用 `grid`，失败时退到 `thumb` 也比白块强。
 */
function candidateSources(photo, kind) {
  const order = kind === 'feature'
    ? [photo.view, photo.grid, photo.thumb, photo.poster]
    : [photo.grid, photo.thumb, photo.poster, photo.view];
  return [...new Set(order.filter(Boolean))];
}

/**
 * 图片加载兜底：换源 → 重试 → 占位卡。
 *
 * 不抛错、不阻塞：一张图挂了只影响它自己那一格，相邻照片照常出现。
 * 重试按钮是给「当时断网、现在好了」准备的，所以复位后从首选源重新开始。
 *
 * Image fallback: next source, then retry, then a placeholder card. A broken
 * image only affects its own tile; nothing throws and nothing blocks.
 */
function attachImageFallback(tile, img, photo, kind) {
  const sources = candidateSources(photo, kind);
  if (!sources.length) return;
  let attempt = 0;

  const clearError = () => {
    tile.classList.remove('is-broken');
    tile.querySelector('.tile-error')?.remove();
  };

  img.addEventListener('error', () => {
    attempt += 1;
    if (attempt < sources.length && attempt <= MAX_IMAGE_ATTEMPTS) {
      img.src = sources[attempt];
      const srcset = srcsetFor({ ...photo, view: sources[attempt], grid: sources[attempt] }, kind);
      if (srcset) img.srcset = srcset; else img.removeAttribute('srcset');
      return;
    }
    showTileError(tile, () => {
      attempt = 0;
      img.addEventListener('load', clearError, { once: true });
      img.src = sources[0];
    });
  });
}

function showTileError(tile, onRetry) {
  tile.classList.add('is-broken');
  if (tile.querySelector('.tile-error')) return;

  const box = document.createElement('div');
  box.className = 'tile-error';
  const text = document.createElement('p');
  text.className = 'tile-error-text';
  text.textContent = '这张暂时打不开';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tile-retry';
  button.textContent = '重试';
  button.addEventListener('click', (event) => {
    // 别把「重试」点成「打开灯箱」
    event.preventDefault();
    event.stopPropagation();
    onRetry();
  });
  box.append(text, button);
  tile.appendChild(box);
}

function createTile(photo, { width, height, kind, onOpen, index }) {
  const tile = document.createElement('figure');
  tile.className = 'tile';
  tile.dataset.id = photo.id;
  tile.dataset.index = String(index);
  // 尺寸只在给了像素时写死；不给就让 CSS 定（每月精选的九宫格格子由网格决定，
  // 内联 `0px` 会把 aspect-ratio 顶掉）。
  // Only pin the size when pixels are given; otherwise CSS decides (the picks
  // grid sizes its cells, and an inline 0px would defeat aspect-ratio).
  if (Number.isFinite(width) && Number.isFinite(height)) {
    tile.style.width = `${width}px`;
    tile.style.height = `${height}px`;
  }
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  // 时长进 aria-label：角标本身是装饰，读屏用户也该知道这条有 34 秒
  const spoken = isMotion(photo) ? spokenDuration(photo.duration) : '';
  tile.setAttribute('aria-label', spoken ? `${photoAlt(photo)}，视频 ${spoken}` : photoAlt(photo));

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
  attachImageFallback(tile, img, photo, kind);

  frame.appendChild(img);
  tile.appendChild(frame);

  if (isMotion(photo)) {
    const badge = document.createElement('span');
    badge.className = 'tile-badge';
    badge.setAttribute('aria-hidden', 'true');
    // 有 duration 就报真实时长，没有（历史数据 / 降级视频）只留一个 ▶
    badge.textContent = badgeText(photo);
    if (!photo.duration) badge.classList.add('is-plain');
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

/**
 * 每月精选块（V6 T-22）：9 张 + 一句话 + 一个跳过的出口。
 *
 * 不渲染空占位：产物缺失、id 对不上清单、当前筛选把它们滤光了都直接不建这个块；
 * 过滤后不足 3 张也不建——剩 1 张还叫「本月精选」是骗人。跳过用真按钮（键盘可达），
 * 只在这一次浏览里生效。
 *
 * No placeholder ever: no artifact, stale ids, or a filter that leaves fewer than
 * three picks all mean no block. The skip is a real button and lasts this visit.
 */
const MIN_VISIBLE_PICKS = 3;

function createMonthPicks(entry, { byId, order, onOpen, onSkip }) {
  const photos = pickPhotos(byId, entry.picks).filter((photo) => order.has(photo.id));
  if (photos.length < MIN_VISIBLE_PICKS) return null;

  const box = document.createElement('section');
  box.className = 'month-picks';
  box.dataset.monthPicks = entry.key;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', `${entry.year} 年 ${entry.month} 月精选，${photos.length} 张`);

  const head = document.createElement('div');
  head.className = 'month-picks-head';

  const label = document.createElement('p');
  label.className = 'month-picks-label';
  label.textContent = `本月精选 · ${photos.length} 张`;
  head.appendChild(label);

  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'month-picks-skip';
  skip.textContent = '跳过本月精选';
  skip.setAttribute('aria-label', `跳过 ${entry.year} 年 ${entry.month} 月的精选`);
  skip.addEventListener('click', () => onSkip(entry.key));
  head.appendChild(skip);
  box.appendChild(head);

  const sentence = typeof entry.sentence === 'string' ? entry.sentence.trim() : '';
  if (sentence) {
    const note = document.createElement('p');
    note.className = 'month-picks-sentence';
    note.textContent = sentence;
    box.appendChild(note);
  }

  const grid = document.createElement('div');
  grid.className = 'month-picks-grid';
  for (const photo of photos) {
    grid.appendChild(createTile(photo, {
      kind: 'picks',
      onOpen,
      index: order.get(photo.id) ?? 0,
    }));
  }
  box.appendChild(grid);

  return box;
}

function createYearSection(plan, { byId, order, onOpen, curation, skipped, onSkip }) {
  const section = document.createElement('section');
  section.className = 'year-group';
  section.dataset.year = String(plan.year);

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
      title.dataset.month = String(item.month);
      title.innerHTML = `${item.month} 月<span>${item.count}</span>`;
      rowsHost.appendChild(title);

      // 策展块挂在月份标题**之下**：标题是这个分组的标签，块是分组的第一行内容。
      // 放在标题之上会让人以为它属于上一个月。
      // The picks block sits under the month heading: the heading labels the
      // group, the block is its first content. Above the heading it would read as
      // belonging to the previous month.
      const key = monthKeyOf({ year: plan.year, month: item.month });
      const entry = curation?.get(key);
      if (entry && !skipped.has(key)) {
        const block = createMonthPicks(entry, { byId, order, onOpen, onSkip });
        if (block) rowsHost.appendChild(block);
      }
    } else {
      rowsHost.appendChild(createRow(item, { byId, onOpen }));
    }
  }

  section.appendChild(rowsHost);

  // 删掉「故事」tab 之后，故事只从年份分组进入——所以按钮必须带上年份
  const storyButton = document.createElement('button');
  storyButton.type = 'button';
  storyButton.className = 'year-story';
  storyButton.dataset.storyYear = String(plan.year);
  storyButton.textContent = `用故事播放 ${plan.year} 年`;
  section.appendChild(storyButton);

  return section;
}

/**
 * 目录渲染器：时间轴（年 → 月 → 编辑式行）。
 * 分批：先渲染 limit 条，滚动到底再追加；重排按容器实测宽度重算。
 *
 * 增量：追加时只增删改动过的那几年，已经画好的年份一个节点都不碰；
 * 宽度变化、筛选重置这类「整页语义变了」的情况仍走全量重排。
 */
export function createCatalog({
  container, onOpen, initialBatch = 60, chunk = 60, density = 'standard',
  curation = null, onSkipCuration = null,
}) {
  let photos = [];
  let limit = initialBatch;
  let frame = null;
  let lastWidth = 0;
  let renderedKeys = [];
  let sections = [];
  let currentDensity = normalizeDensity(density);
  // 每月精选（T-22）：图谱与「已跳过」都在闭包里，重排不会把跳过状态弄丢
  let curationIndex = curation instanceof Map ? curation : new Map();
  const skippedPicks = new Set();

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
    const plan = planCatalog(visible, width, currentDensity);
    // 精选块要能打开「可见部分之外」的照片，所以索引建在整份列表上
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    const order = new Map(photos.map((photo, index) => [photo.id, index]));
    const nodes = plan.years.map((yearPlan) => createYearSection(yearPlan, {
      byId, order, onOpen, curation: curationIndex, skipped: skippedPicks, onSkip: skipPicks,
    }));

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
    const plan = planCatalog(visible, width, currentDensity);
    const { keep, rebuild, stale } = diffYears(renderedKeys, plan.years);
    if (!rebuild.length && !stale) return; // 没有任何变化：一个节点都不碰

    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    const order = new Map(photos.map((photo, index) => [photo.id, index]));
    for (let i = keep; i < sections.length; i += 1) sections[i].remove();
    sections.length = keep;
    renderedKeys.length = keep;

    if (!rebuild.length) return;
    const fragment = document.createDocumentFragment();
    const appended = [];
    for (const yearPlan of rebuild) {
      const node = createYearSection(yearPlan, {
        byId, order, onOpen, curation: curationIndex, skipped: skippedPicks, onSkip: skipPicks,
      });
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

  /**
   * 跳过本月的精选：块自己消失，别的 DOM 一个都不动。
   * 不重排整页是有意的——用户刚点完按钮，页面跳动会让人以为点错了东西。
   */
  function skipPicks(key) {
    if (!key || skippedPicks.has(key)) return;
    skippedPicks.add(key);
    for (const section of sections) {
      const walk = (node) => {
        const blocks = Array.isArray(node.children)
          ? node.children.filter((child) => child?.dataset?.monthPicks === key)
          : [];
        for (const block of blocks) node.children.splice(node.children.indexOf(block), 1);
        for (const child of Array.isArray(node.children) ? [...node.children] : []) walk(child);
      };
      walk(section);
    }
    onSkipCuration?.(key);
  }

  return {
    /** 策展产物是异步到的：到了再挂上并重排一次 */
    setCuration(next) {
      const index = next instanceof Map ? next : new Map();
      curationIndex = index;
      skippedPicks.clear();
      paintFull();
      return index.size;
    },
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
    /** 切密度：整页重排一次（行布局全变了，增量没有意义） */
    setDensity(next) {
      const value = normalizeDensity(next);
      if (value === currentDensity) return false;
      currentDensity = value;
      paintFull();
      return true;
    },
    get density() { return currentDensity; },
    get hasMore() { return limit < photos.length; },
    destroy() { observer.disconnect(); },
  };
}

/* ---------- 精选 ---------- */



/* ---------- 相册卡片 ---------- */

export function renderAlbums(host, albums, { onOpenAlbum, byId, photos = [] }) {
  host.replaceChildren();

  // 一次分组，避免每张卡片都对全部照片 filter 一遍
  const members = new Map();
  for (const photo of photos) {
    if (!photo.album) continue;
    if (!members.has(photo.album)) members.set(photo.album, []);
    members.get(photo.album).push(photo);
  }

  for (const album of albums) {
    const summary = albumSummary(album, members.get(album.name) || []);
    const cover = summary.cover || byId?.get(summary.coverId);
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
      img.src = cover.grid || cover.thumb || cover.poster;
      markWhenReady(img, img, 'is-loaded');
      frame.appendChild(img);
    }

    const name = document.createElement('h3');
    name.textContent = album.name;
    const meta = document.createElement('p');
    meta.className = 'album-meta';
    // 只报「张数 · 时间跨度」：manifest 没有发布时间，就不编「最近更新」（O-03）
    meta.textContent = summary.span
      ? `${summary.count} 张 · ${summary.span}`
      : `${summary.count} 张`;

    card.append(frame, name, meta);
    card.addEventListener('click', () => onOpenAlbum(album.name));
    host.appendChild(card);
  }
}

export { stopPreview };
