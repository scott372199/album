import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTH_SLOTS, MAX_YEAR_TAGS,
  normalizeYear, yearPhotos, monthHeat, topTags, dominantColour, buildYearSummary,
  createYearPage, renderYearNav,
} from '../js/year-page.js';
import { parseHashString, buildHash } from '../js/state.js';

/**
 * V6 T-24「这一年」年度页。
 *
 * 最要紧的两条判据是可执行的：
 *   1. **12 格恒长**——空月必须留下格子。按有照片的月份生成格子，等于让读者
 *      自己数空白，「2 月一张都没有」这个事实就看不见了。
 *   2. **不新增 hash 键**——`view=year` + `year=` 都是既有键，这里直接跑
 *      parseHashString / buildHash 验一遍。
 *
 * Two criteria are executable here: the heat bar always has 12 slots (empty
 * months stay visible as blanks), and the page introduces no new hash keys.
 */

/** 一份小样本：2026 有 5 张，2025 有 1 张，2024 空 */
const photos = [
  { id: 'a', type: 'image', year: 2026, month: 1 },
  { id: 'b', type: 'image', year: 2026, month: 1 },
  { id: 'c', type: 'video', year: 2026, month: 6 },
  { id: 'd', type: 'image', year: 2026, month: 11 },
  { id: 'e', type: 'image', year: 2026, month: 11 },
  { id: 'f', type: 'image', year: 2025, month: 3 },
];

const items = [
  {
    id: 'a', year: 2026, colors: ['grey', 'urban', 'blue'],
    labels: [
      { term: 'shirt', zh: '衬衫', kind: 'object' },
      { term: 'lake', zh: '湖水', kind: 'scene' },
      { term: 'red', zh: '红色', kind: 'color' },
    ],
  },
  {
    id: 'b', year: 2026, colors: ['grey', 'blue'],
    labels: [
      { term: 'shirt', zh: '衬衫', kind: 'object' },
      { term: 'car', zh: '汽车', kind: 'object' },
      { term: 'person', zh: 'person', kind: 'object' },   // 没翻译，不该出现
    ],
  },
  {
    id: 'c', year: 2026, colors: ['grey'],
    labels: [{ term: 'mountain', zh: '山峰', kind: 'scene' }],
  },
  { id: 'f', year: 2025, colors: ['pink'], labels: [{ term: 'shirt', zh: '衬衫', kind: 'object' }] },
];

test('normalizeYear：只认 1900–2199 的整数', () => {
  assert.equal(normalizeYear('2026'), 2026);
  assert.equal(normalizeYear(2026), 2026);
  for (const value of [undefined, null, '', 'abc', 1899, 2200, 2026.5, NaN]) {
    assert.equal(normalizeYear(value), null, `${String(value)} 应当被拒`);
  }
});

test('yearPhotos：只取指定年份', () => {
  assert.equal(yearPhotos(photos, 2026).length, 5);
  assert.equal(yearPhotos(photos, 2024).length, 0);
  assert.equal(yearPhotos(photos, 'x').length, 0);
});

test('monthHeat：永远是 12 格，空月留白', () => {
  const heat = monthHeat(photos, 2026);
  assert.equal(heat.length, MONTH_SLOTS);
  assert.deepEqual(heat.map((slot) => slot.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(heat.map((slot) => slot.count), [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0]);
  // 空月：份额 0、档位 0，但格子还在（不能因为没照片就被过滤掉）
  for (const slot of heat.filter((item) => item.count === 0)) {
    assert.equal(slot.share, 0);
    assert.equal(slot.level, 0);
  }
});

test('monthHeat：最高月占满，其余按比例', () => {
  const heat = monthHeat(photos, 2026);
  const max = Math.max(...heat.map((slot) => slot.count));
  assert.equal(heat.find((slot) => slot.count === max).share, 1);
  assert.equal(heat.find((slot) => slot.month === 6).share, 0.5);
});

test('monthHeat：一年没有照片时也不塌成 0 格', () => {
  const heat = monthHeat(photos, 2024);
  assert.equal(heat.length, MONTH_SLOTS);
  assert.ok(heat.every((slot) => slot.count === 0 && slot.level === 0));
});

test('topTags：最多 3 个、只留中文、同一张不重复计', () => {
  const tags = topTags(items.filter((item) => item.year === 2026));
  assert.equal(tags.length, MAX_YEAR_TAGS);
  assert.equal(tags[0].zh, '衬衫');
  assert.equal(tags[0].count, 2, '出现在两张照片里就是 2');
  for (const tag of tags) {
    assert.match(tag.zh, /[\u4e00-\u9fa5]/, `「${tag.zh}」没有中文，不该出现在中文界面里`);
  }
  assert.ok(!tags.some((tag) => tag.zh === '红色'), '颜色走主色那一栏，不占标签位');
});

test('topTags：条数相同按词排序，产物稳定（不用 localeCompare）', () => {
  const same = topTags([
    { id: 'x', labels: [{ term: 'a', zh: '乙', kind: 'object' }, { term: 'b', zh: '甲', kind: 'object' }] },
  ]);
  assert.deepEqual(same.map((tag) => tag.zh), ['乙', '甲'].sort());
});

test('dominantColour：过滤非颜色词，取出现最多的那个', () => {
  const colour = dominantColour(items.filter((item) => item.year === 2026));
  assert.equal(colour.term, 'grey');
  assert.equal(colour.zh, '灰色');
  assert.equal(colour.count, 3);
});

test('dominantColour：没有颜色数据时返回 null，不编一个默认色', () => {
  assert.equal(dominantColour([]), null);
  assert.equal(dominantColour([{ id: 'x', colors: ['urban'] }]), null);
});

test('buildYearSummary：张数、视频、有照片的月份数', () => {
  const summary = buildYearSummary({ photos, items, year: 2026 });
  assert.equal(summary.year, 2026);
  assert.equal(summary.count, 5);
  assert.equal(summary.photos, 4);
  assert.equal(summary.videos, 1);
  assert.equal(summary.monthsFilled, 3);
  assert.equal(summary.empty, false);
  assert.equal(summary.tags[0].zh, '衬衫');
  assert.equal(summary.colour.zh, '灰色');
});

test('buildYearSummary：空年份要能明确说「没有照片」', () => {
  const summary = buildYearSummary({ photos, items, year: 2024 });
  assert.equal(summary.count, 0);
  assert.equal(summary.empty, true);
  assert.equal(summary.tags.length, 0);
  assert.equal(summary.colour, null);
  assert.equal(summary.monthsFilled, 0);
});

test('buildYearSummary：索引缺失时张数与热度条照常，只是没有标签与主色', () => {
  const summary = buildYearSummary({ photos, year: 2026 });
  assert.equal(summary.count, 5);
  assert.equal(summary.tags.length, 0);
  assert.equal(summary.colour, null);
});

/* ---------- 路由：不新增 hash 键 ---------- */

test('路由：view=year 复用既有键，年份走既有的 year 键', () => {
  const snapshot = {};
  parseHashString('#view=year&year=2026', snapshot);
  assert.equal(snapshot.view, 'year');
  assert.equal(snapshot.year, '2026');

  const round = buildHash({ view: 'year', year: '2026', mode: null, filtered: [], lightbox: { index: -1 } });
  assert.equal(round, '#view=year&year=2026');
});

/* ---------- 装配 ---------- */

/** 够用的假 DOM：append/replaceChildren/属性/监听/classList/dataset/style */
function fakeDom() {
  const node = (tag) => ({
    tagName: tag,
    children: [],
    dataset: {},
    attrs: {},
    listeners: {},
    style: {},
    hidden: false,
    disabled: false,
    className: '',
    textContent: '',
    classList: {
      set: new Set(),
      add(name) { this.set.add(name); },
      toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); },
      contains(name) { return this.set.has(name); },
    },
    append(...items) { this.children.push(...items); },
    appendChild(child) {
      if (child.isFragment) this.children.push(...child.children);
      else this.children.push(child);
      return child;
    },
    replaceChildren(...items) {
      this.children = items.flatMap((item) => (item?.isFragment ? item.children : [item]));
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({ target: this }); },
    findByClass(name) {
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.className || '').split(' ').includes(name)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    findAllByClass(name) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.className || '').split(' ').includes(name)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  });
  const doc = {
    createElement: node,
    createDocumentFragment: () => Object.assign(node('#fragment'), { isFragment: true }),
  };
  return { doc, node };
}

test('装配：12 个格子，空月 disabled 且没有柱子高度', () => {
  const { doc, node } = fakeDom();
  const host = node('section');
  const page = createYearPage({ host, doc });
  page.render(buildYearSummary({ photos, items, year: 2026 }));

  const cells = host.findAllByClass('year-cell');
  assert.equal(cells.length, 12, '空月也必须占一格');

  const feb = cells.find((cell) => cell.dataset.month === '2');
  assert.equal(feb.dataset.empty, 'true');
  assert.equal(feb.disabled, true, '空月点进去是空列表，不如不给点');
  assert.equal(feb.attrs['aria-label'], '2 月没有照片');

  const nov = cells.find((cell) => cell.dataset.month === '11');
  assert.equal(nov.dataset.empty, 'false');
  assert.equal(nov.disabled, false);
  assert.equal(nov.attrs['aria-label'], '11 月 2 张');
  assert.equal(nov.findByClass('year-bar').style.height, '100%');

  const jun = cells.find((cell) => cell.dataset.month === '6');
  assert.equal(jun.findByClass('year-bar').style.height, '50%');
  assert.equal(feb.findByClass('year-bar').style.height, '0%');
});

test('装配：点月份 / 点标签 / 点「看这一年」都回调', () => {
  const { doc, node } = fakeDom();
  const host = node('section');
  const calls = [];
  const page = createYearPage({
    host,
    doc,
    onPickMonth: (month) => calls.push(`month:${month}`),
    onPickTag: (zh) => calls.push(`tag:${zh}`),
    onReset: () => calls.push('reset'),
  });
  page.render(buildYearSummary({ photos, items, year: 2026 }));

  host.findAllByClass('year-cell').find((cell) => cell.dataset.month === '6').click();
  host.findAllByClass('year-tag')[0].click();
  host.findByClass('year-open').click();
  assert.deepEqual(calls, ['month:6', 'tag:衬衫', 'reset']);
});

test('装配：空年份显示「这一年没有照片」，热度条与出口都藏起来', () => {
  const { doc, node } = fakeDom();
  const host = node('section');
  const page = createYearPage({ host, doc });
  page.render(buildYearSummary({ photos, items, year: 2024 }));

  assert.equal(host.findByClass('year-empty').textContent, '这一年没有照片');
  assert.equal(host.findByClass('year-empty').hidden, false);
  assert.equal(host.findByClass('year-heat').hidden, true);
  assert.equal(host.findByClass('year-open').hidden, true);
  assert.equal(host.classList.contains('is-empty'), true);
});

test('装配：主色写成「主色：灰色 · 3 张」并带色块', () => {
  const { doc, node } = fakeDom();
  const host = node('section');
  const page = createYearPage({ host, doc });
  page.render(buildYearSummary({ photos, items, year: 2026 }));

  const colour = host.findByClass('year-colour');
  assert.match(JSON.stringify(colour.children.map((child) => child.textContent)), /主色：灰色 · 3 张/);
  assert.equal(colour.findByClass('year-swatch').dataset.colour, 'grey');
});

test('装配：标题带上年份，张数与视频数分得清', () => {
  const { doc, node } = fakeDom();
  const host = node('section');
  const page = createYearPage({ host, doc });
  page.render(buildYearSummary({ photos, items, year: 2026 }));

  assert.equal(host.findByClass('year-title').textContent, '2026 年');
  const meta = host.findByClass('year-meta').textContent;
  assert.match(meta, /5 张/);
  assert.match(meta, /视频 1 条/);
  assert.match(meta, /3 个月有照片/);
  assert.match(meta, /照片 4 张/);
});

test('年份入口条：每个年份一个按钮，当前年份是高亮态', () => {
  const { doc, node } = fakeDom();
  const host = node('div');
  const opened = [];
  renderYearNav(host, [2026, 2025], { current: '2026', onOpen: (y) => opened.push(y), doc });

  assert.equal(host.hidden, false);
  const buttons = host.children;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].classList.contains('is-current'), true);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[1].classList.contains('is-current'), false);

  buttons[1].click();
  assert.deepEqual(opened, [2025]);
});

test('年份入口条：没有年份就整块藏起来，不留一条空行', () => {
  const { doc, node } = fakeDom();
  const host = node('div');
  renderYearNav(host, [], { doc });
  assert.equal(host.hidden, true);
});
