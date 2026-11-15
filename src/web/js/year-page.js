/**
 * 「这一年」年度页 / The year page (V6 T-24).
 *
 * 只用已有的两份数据：清单（张数、年月）与语义索引（标签、色彩）。**不发任何
 * 新请求**——页面上没有一张照片，所以除了清单与索引之外一个字节都不用拉。
 *
 * 四块内容：张数、12 格月度热度条、Top-3 标签、主色。
 *
 * 两条纪律：
 *
 * 1. **12 格恒长**。没有照片的月份留白但**不压缩**，这样「2026 年 2 月一张都
 *    没有」也是一个看得见的事实，而不是被悄悄跳过。按月份数动态生成格子等于
 *    让读者自己数空白，是另一种撒谎。
 * 2. **粒度只到月**。不变量 6 禁止「这天拍了 N 张」，所以这里不出现任何日级
 *    数字，也不出现「最常拍照的一天」。
 *
 * Two existing sources only, no new requests: the page shows no photos at all, so
 * the manifest and the search index are enough. Four blocks: count, a fixed
 * 12-slot month heat bar (empty months stay as blanks so "nothing in February"
 * remains visible), top-3 labels and the dominant colour. Month granularity only
 * — day-level wording is forbidden by invariant 6.
 */

import { TERM_ZH, COLOR_TERMS } from './lexicon.generated.js';

export const MONTH_SLOTS = 12;
export const MAX_YEAR_TAGS = 3;
/** 热度分几档：类数太多肉眼分不出，太少又看不出差别 */
export const HEAT_LEVELS = 4;

const CJK = /[\u4e00-\u9fa5]/;
/** 标签只认「东西」和「场景」；颜色另走主色那一栏，避免「红色 12 次」同时占两个位置 */
const TAG_KINDS = new Set(['object', 'scene']);

/** 年份洗一遍：只接受 1900–2199 的整数，其它一律当作「没指定」 */
export function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2199) return null;
  return year;
}

export function yearPhotos(photos, year) {
  const target = normalizeYear(year);
  const list = Array.isArray(photos) ? photos : [];
  if (!target) return [];
  return list.filter((photo) => photo && photo.year === target);
}

/**
 * 12 格热度。`share` 是相对最高那月的比例（0–1），`level` 是离散档位，
 * 空月 `level: 0` 且 `share: 0`——格子还在，只是没有柱子。
 */
export function monthHeat(photos, year) {
  const counts = new Array(MONTH_SLOTS).fill(0);
  for (const photo of yearPhotos(photos, year)) {
    const month = Number(photo.month);
    if (!Number.isInteger(month) || month < 1 || month > MONTH_SLOTS) continue;
    counts[month - 1] += 1;
  }
  const max = Math.max(...counts, 0);
  return counts.map((count, index) => ({
    month: index + 1,
    count,
    share: max ? count / max : 0,
    level: count ? Math.max(1, Math.ceil((count / max) * HEAT_LEVELS)) : 0,
  }));
}

/**
 * Top-N 标签。只收有中文的标签——索引里的 `labels[].zh` 在词表没覆盖时会退回
 * 英文原词，把它当中文标题摆出来只会显得像没做完。同一张照片同一个词只算一次。
 * 排序不带 `localeCompare`：产物要按字节稳定，ICU 差异会翻车。
 */
export function topTags(items, { limit = MAX_YEAR_TAGS } = {}) {
  const list = Array.isArray(items) ? items : [];
  const counter = new Map();
  for (const item of list) {
    if (!item) continue;
    const seen = new Set();
    for (const label of item.labels || []) {
      if (!label || !TAG_KINDS.has(label.kind)) continue;
      const zh = String(label.zh || '').trim();
      if (!zh || !CJK.test(zh) || seen.has(zh)) continue;
      seen.add(zh);
      const entry = counter.get(zh) || { zh, term: String(label.term || ''), count: 0 };
      entry.count += 1;
      counter.set(zh, entry);
    }
  }
  return [...counter.values()]
    .sort((a, b) => (b.count - a.count) || (a.zh < b.zh ? -1 : a.zh > b.zh ? 1 : 0))
    .slice(0, limit);
}

/**
 * 主色：`item.colors` 里出现最多的**颜色词**。
 *
 * 索引的 `colors` 里混着非颜色词（实测线上有 `urban`），所以必须过一遍
 * `COLOR_TERMS` 白名单，否则「主色：urban」会很荒唐。
 */
export function dominantColour(items) {
  const list = Array.isArray(items) ? items : [];
  const counter = new Map();
  for (const item of list) {
    if (!item) continue;
    const seen = new Set();
    for (const term of item.colors || []) {
      const key = String(term || '').trim().toLowerCase();
      if (!key || !COLOR_TERMS.has(key) || seen.has(key)) continue;
      seen.add(key);
      counter.set(key, (counter.get(key) || 0) + 1);
    }
  }
  if (!counter.size) return null;
  const [term, count] = [...counter.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
  return { term, zh: TERM_ZH[term] || term, count };
}

/**
 * 汇总。`items` 是语义索引条目（可缺省——索引还没加载时页面照样要有张数和
 * 热度条，只是没有标签与主色）。
 */
export function buildYearSummary({ photos = [], items = [], year } = {}) {
  const target = normalizeYear(year);
  if (!target) {
    return {
      year: null, count: 0, photos: 0, videos: 0, months: monthHeat([], null),
      monthsFilled: 0, tags: [], colour: null, empty: true,
    };
  }
  const inYear = yearPhotos(photos, target);
  const inYearItems = (Array.isArray(items) ? items : []).filter((item) => item && item.year === target);
  const months = monthHeat(photos, target);
  return {
    year: target,
    count: inYear.length,
    photos: inYear.filter((photo) => photo.type !== 'video').length,
    videos: inYear.filter((photo) => photo.type === 'video').length,
    months,
    monthsFilled: months.filter((slot) => slot.count > 0).length,
    tags: topTags(inYearItems),
    colour: dominantColour(inYearItems),
    empty: inYear.length === 0,
  };
}

/* ---------- 装配 / Assembly ---------- */

/**
 * 把汇总结果画进 `host`。整块重建（12 格 + 3 个标签而已，没有增量更新的必要），
 * 每次渲染只做 DOM 拼装，不触发任何网络。
 */
export function createYearPage({
  host, onPickMonth = null, onPickTag = null, onReset = null,
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  if (!host || !doc) return { render() {}, destroy() {} };

  const head = doc.createElement('div');
  head.className = 'year-head';
  const kicker = doc.createElement('p');
  kicker.className = 'section-kicker';
  kicker.textContent = 'THIS YEAR';
  const title = doc.createElement('h2');
  title.className = 'year-title';
  const meta = doc.createElement('p');
  meta.className = 'year-meta';
  head.append(kicker, title, meta);

  const empty = doc.createElement('p');
  empty.className = 'year-empty';
  empty.textContent = '这一年没有照片';
  empty.hidden = true;

  const heat = doc.createElement('div');
  heat.className = 'year-heat';
  heat.setAttribute('role', 'group');
  heat.setAttribute('aria-label', '按月张数');

  const side = doc.createElement('div');
  side.className = 'year-side';
  const tags = doc.createElement('div');
  tags.className = 'year-tags';
  tags.setAttribute('role', 'group');
  tags.setAttribute('aria-label', '这一年的高频标签');
  const colour = doc.createElement('p');
  colour.className = 'year-colour';
  side.append(tags, colour);

  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.className = 'year-open';
  reset.textContent = '看这一年的照片';
  reset.addEventListener('click', () => onReset?.());

  host.replaceChildren(head, empty, heat, side, reset);

  function render(summary) {
    const data = summary || buildYearSummary({});
    const { year, count, photos: still, videos, months, monthsFilled } = data;

    host.dataset.year = year ? String(year) : '';
    host.classList.toggle('is-empty', Boolean(data.empty));
    title.textContent = year ? `${year} 年` : '这一年';
    meta.textContent = data.empty
      ? ''
      : `${count} 张 · 视频 ${videos} 条 · ${monthsFilled} 个月有照片`;
    empty.hidden = !data.empty;
    if (!year) meta.textContent = '';
    // 「张」在这套界面里是总称（照片 + 视频），但视频单列了一条，所以这里补一句
    // 照片张数，免得 47 与 34 两个数对不上时没人解释。
    if (!data.empty && videos) meta.textContent += `（照片 ${still} 张）`;

    heat.hidden = Boolean(data.empty);
    heat.replaceChildren();
    for (const slot of months) {
      const cell = doc.createElement('button');
      cell.type = 'button';
      cell.className = 'year-cell';
      cell.dataset.month = String(slot.month);
      cell.dataset.empty = slot.count ? 'false' : 'true';
      cell.dataset.level = String(slot.level);
      cell.setAttribute('aria-label', slot.count ? `${slot.month} 月 ${slot.count} 张` : `${slot.month} 月没有照片`);
      if (!slot.count) {
        // 空月保留格子但不给点击：留白是信息，点进去是空列表则不是
        cell.disabled = true;
        cell.tabIndex = -1;
      } else {
        cell.addEventListener('click', () => onPickMonth?.(slot.month));
      }
      const bar = doc.createElement('span');
      bar.className = 'year-bar';
      bar.style.height = `${Math.round(slot.share * 100)}%`;
      const label = doc.createElement('span');
      label.className = 'year-month';
      label.textContent = String(slot.month);
      cell.append(bar, label);
      heat.appendChild(cell);
    }

    tags.replaceChildren();
    for (const tag of data.tags) {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'year-tag';
      chip.textContent = `${tag.zh} ${tag.count}`;
      chip.addEventListener('click', () => onPickTag?.(tag.zh));
      tags.appendChild(chip);
    }
    tags.hidden = data.tags.length === 0;

    colour.replaceChildren();
    if (data.colour) {
      const swatch = doc.createElement('span');
      swatch.className = 'year-swatch';
      swatch.dataset.colour = data.colour.term;
      swatch.setAttribute('aria-hidden', 'true');
      const text = doc.createElement('span');
      text.textContent = `主色：${data.colour.zh} · ${data.colour.count} 张`;
      colour.append(swatch, text);
    }
    colour.hidden = !data.colour;

    reset.hidden = Boolean(data.empty);
  }

  return { render, destroy() { host.replaceChildren(); } };
}

/**
 * 年份入口条：只在「相册」根页面出现，点年份进年度页。
 * 年份从清单里来，所以新照片进来不需要改任何配置。
 */
export function renderYearNav(host, years, { current = '', onOpen = null, doc = typeof document !== 'undefined' ? document : null } = {}) {
  if (!host || !doc) return;
  const list = (Array.isArray(years) ? years : []).filter((year) => normalizeYear(year));
  host.replaceChildren();
  host.hidden = list.length === 0;
  for (const year of list) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'year-nav-item';
    button.textContent = `${year} 年`;
    button.setAttribute('aria-pressed', String(String(current) === String(year)));
    button.classList.toggle('is-current', String(current) === String(year));
    button.addEventListener('click', () => onOpen?.(normalizeYear(year)));
    host.appendChild(button);
  }
}
