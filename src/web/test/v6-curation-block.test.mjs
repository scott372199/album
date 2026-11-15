import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CURATION_VERSION, resolveCurationUrl, isCurationUsable, loadCuration,
  curationIndex, pickPhotos, monthKeyOf,
} from '../js/curation.js';
import { createCatalog } from '../js/gallery.js';

/**
 * V6 T-22 每月精选块：产物读取 + 时间流里的那一块。
 *
 * 前端这块最容易犯的两个错，都用断言钉住了：
 *   1. **空占位**——产物缺失、id 对不上、当前筛选把它们滤光了，都不能留一个
 *      空盒子（FR-01 明写「不得渲染空占位」）。所以「没有就一个节点都不建」。
 *   2. **跳过后又自己回来**——跳过记在闭包里，重排（切密度、追加批次）不能把
 *      它忘掉；只有换了新产物（`setCuration`）才该重新出现。
 *
 * 本仓库没有 jsdom：DOM 用一个手写假树，只实现被测代码真正用到的方法。
 */

/* ---------- 假 DOM ---------- */

function fakeDom() {
  const node = (tag) => {
    const el = {
      tagName: tag,
      children: [],
      parent: null,
      dataset: {},
      attrs: {},
      listeners: {},
      style: { setProperty() {} },
      hidden: false,
      disabled: false,
      className: '',
      textContent: '',
      type: '',
      tabIndex: 0,
      classList: {
        set: new Set(),
        add(name) { this.set.add(name); },
        contains(name) { return this.set.has(name); },
      },
      appendChild(child) {
        if (child?.isFragment) {
          for (const kid of child.children) { kid.parent = el; el.children.push(kid); }
          return child;
        }
        child.parent = el;
        el.children.push(child);
        return child;
      },
      append(...items) { for (const item of items) el.appendChild(item); },
      replaceChildren(...items) {
        el.children = [];
        for (const item of items) el.appendChild(item);
      },
      remove() {
        if (!el.parent) return;
        const at = el.parent.children.indexOf(el);
        if (at >= 0) el.parent.children.splice(at, 1);
        el.parent = null;
      },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k]; },
      addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
      click() { for (const fn of el.listeners.click || []) fn({ target: el, preventDefault() {} }); },
      querySelector() { return null; },
      findAllByClass(name) {
        const out = [];
        const walk = (n) => {
          for (const child of n.children) {
            if (String(child.className || '').split(' ').includes(name)) out.push(child);
            walk(child);
          }
        };
        walk(el);
        return out;
      },
    };
    return el;
  };

  const doc = {
    createElement: node,
    createDocumentFragment: () => Object.assign(node('#fragment'), { isFragment: true }),
  };
  return { doc, node };
}

/** 装好 createCatalog 需要的三个全局物 */
function installDom(doc) {
  const previous = {
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  globalThis.document = doc;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 1; };
  return () => {
    globalThis.document = previous.document;
    globalThis.ResizeObserver = previous.ResizeObserver;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
  };
}

const photosOf = (count, { year = 2026, month = 11, prefix = 'p' } = {}) => Array.from(
  { length: count },
  (_, i) => ({
    id: `${prefix}${String(i).padStart(2, '0')}`,
    type: 'image',
    album: String(year),
    year,
    month,
    ratio: 1.3,
    lqip: '',
    featured: false,
    grid: `${prefix}${i}/grid.webp`,
    thumb: `${prefix}${i}/thumb.webp`,
  }),
);

const docOf = (months) => ({ version: CURATION_VERSION, rev: 'abcdef12', months, picks: [] });

/** 一个 9 张的块（一年一个月，正好一块） */
const oneBlock = () => {
  const photos = photosOf(9);
  return {
    photos,
    doc: docOf([{
      year: 2026,
      month: 11,
      count: 9,
      picks: photos.map((photo) => photo.id),
      sentence: '风把树吹得乱响',
    }]),
  };
};

/* ---------- 产物地址与读取 ---------- */

test('产物地址：rev 只认十六进制，其它一律走固定名', () => {
  assert.equal(resolveCurationUrl('a75ad99f'), 'data/curation.a75ad99f.json');
  assert.equal(resolveCurationUrl(''), '');
  assert.equal(resolveCurationUrl('../../etc/passwd'), '');
  assert.equal(resolveCurationUrl('a75ad99'), '', '太短的不像 rev');
});

test('先拿 rev 版，失败退固定名；两份都没有就是 null', async () => {
  const requested = [];
  const ok = (body) => async (url) => {
    requested.push(url);
    return { ok: true, status: 200, json: async () => body };
  };

  const versioned = await loadCuration({
    rev: 'abcdef12',
    fetchImpl: ok(docOf([])),
    now: () => 42,
  });
  assert.ok(versioned);
  assert.deepEqual(requested, ['data/curation.abcdef12.json'], 'rev 版拿到了就不用问固定名');

  requested.length = 0;
  const fallback = await loadCuration({
    rev: 'abcdef12',
    now: () => 42,
    fetchImpl: async (url) => {
      requested.push(url);
      if (/^data\/curation\.[0-9a-f]+\.json$/.test(url)) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => docOf([]) };
    },
  });
  assert.ok(fallback);
  assert.equal(requested.length, 2);
  assert.equal(requested[1], 'data/curation.json?_=42', '固定名带时间戳，躲开中间层缓存');

  const none = await loadCuration({
    rev: '',
    fetchImpl: async () => { throw new Error('断网'); },
  });
  assert.equal(none, null, '读不到是正常状态，不抛错');
});

test('版本对不上的产物不认：宁可没有精选，也不要画错结构', async () => {
  const stale = await loadCuration({
    rev: '',
    fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ version: 99, months: [] }),
    }),
  });
  assert.equal(stale, null);
  assert.equal(isCurationUsable({ version: CURATION_VERSION, months: [] }), true);
  assert.equal(isCurationUsable({ version: CURATION_VERSION }), false);
});

test('索引：月份不合法、picks 为空或全不是字符串的块一律丢掉', () => {
  const index = curationIndex(docOf([
    { year: 2026, month: 11, count: 9, picks: ['a'], sentence: '  有风  ' },
    { year: 2026, month: 13, count: 9, picks: ['a'] },
    { year: 0, month: 1, count: 9, picks: ['a'] },
    { year: 2026, month: 10, count: 9, picks: [] },
    { year: 2026, month: 9, count: 9, picks: [1, 2] },
  ]));
  assert.deepEqual([...index.keys()], ['2026-11']);
  assert.equal(index.get('2026-11').sentence, '有风');
  assert.equal(index.get('2026-11').year, 2026);
  assert.equal(curationIndex(null).size, 0);
});

test('id 换照片：保持选片顺序，清单里没有的 id 直接丢', () => {
  const photos = photosOf(3);
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const picked = pickPhotos(byId, ['p02', 'gone', 'p00']);
  assert.deepEqual(picked.map((photo) => photo.id), ['p02', 'p00']);
  assert.deepEqual(pickPhotos(null, ['p00']), []);
});

test('monthKeyOf 与月份横条共用一份定义，不各写一遍', async () => {
  assert.equal(monthKeyOf({ year: 2026, month: 9 }), '2026-09');
  const source = await readFile(new URL('../js/curation.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ monthKeyOf \} from '\.\/month-strip\.js'/, '年月键只能有一份实现');
  assert.match(source, /export \{ monthKeyOf \}/);
});

/* ---------- 时间流里的那一块 ---------- */

test('九张 + 一句话 + 一个跳过的按钮', () => {
  const { doc, node } = fakeDom();
  const restore = installDom(doc);
  try {
    const { photos, doc: curation } = oneBlock();
    const container = node('div');
    container.clientWidth = 1280;
    const catalog = createCatalog({ container, onOpen: () => {}, curationIndex: undefined });
    catalog.update(photos);
    catalog.setCuration(curationIndex(curation));

    const blocks = container.findAllByClass('month-picks');
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.dataset.monthPicks, '2026-11');
    assert.equal(block.attrs.role, 'group');
    assert.equal(block.attrs['aria-label'], '2026 年 11 月精选，9 张');

    assert.equal(block.findAllByClass('tile').length, 9);
    assert.equal(block.findAllByClass('month-picks-label')[0].textContent, '本月精选 · 9 张');

    const sentences = block.findAllByClass('month-picks-sentence');
    assert.equal(sentences.length, 1);
    assert.equal(sentences[0].textContent, '风把树吹得乱响');

    const skip = block.findAllByClass('month-picks-skip')[0];
    assert.equal(skip.tagName, 'button', '跳过必须是真按钮，键盘 Tab 得能到（FR-07）');
    assert.equal(skip.type, 'button');
    assert.equal(skip.textContent, '跳过本月精选');
    assert.equal(skip.attrs['aria-label'], '跳过 2026 年 11 月的精选');

    // 瓦片的 index 指向整份列表，点进去才是对的那一张
    const tiles = block.findAllByClass('tile');
    assert.deepEqual(tiles.map((tile) => tile.dataset.index), photos.map((_, i) => String(i)));
  } finally {
    restore();
  }
});

test('没有句子就只出九张，不留一行空白', () => {
  const { doc, node } = fakeDom();
  const restore = installDom(doc);
  try {
    const { photos, doc: curation } = oneBlock();
    curation.months[0].sentence = null;
    const container = node('div');
    container.clientWidth = 1280;
    const catalog = createCatalog({ container, onOpen: () => {} });
    catalog.update(photos);
    catalog.setCuration(curationIndex(curation));

    const block = container.findAllByClass('month-picks')[0];
    assert.ok(block);
    assert.equal(block.findAllByClass('month-picks-sentence').length, 0);
    assert.equal(block.findAllByClass('tile').length, 9);
  } finally {
    restore();
  }
});

test('产物缺失时不渲染任何占位', () => {
  const { doc, node } = fakeDom();
  const restore = installDom(doc);
  try {
    const { photos } = oneBlock();
    const container = node('div');
    container.clientWidth = 1280;
    const catalog = createCatalog({ container, onOpen: () => {} });
    catalog.update(photos);
    assert.equal(container.findAllByClass('month-picks').length, 0, '没有台词就别搭台子');

    // 产物到了但为空表：一样什么都不建
    catalog.setCuration(curationIndex(docOf([])));
    assert.equal(container.findAllByClass('month-picks').length, 0);
  } finally {
    restore();
  }
});

test('筛选把精选滤掉大半时整块不出现：剩 1–2 张还叫「精选」是骗人', () => {
  const { doc, node } = fakeDom();
  const restore = installDom(doc);
  try {
    const { photos, doc: curation } = oneBlock();
    const container = node('div');
    container.clientWidth = 1280;
    const catalog = createCatalog({ container, onOpen: () => {} });
    catalog.update(photos);
    catalog.setCuration(curationIndex(curation));
    assert.equal(container.findAllByClass('month-picks').length, 1);

    // 只剩 2 张（筛选后的列表就是这 2 张）
    catalog.update(photos.slice(0, 2));
    assert.equal(container.findAllByClass('month-picks').length, 0);
  } finally {
    restore();
  }
});

test('跳过：块自己消失，重排（切密度）也不会自己回来', () => {
  const { doc, node } = fakeDom();
  const restore = installDom(doc);
  try {
    const { photos, doc: curation } = oneBlock();
    const container = node('div');
    container.clientWidth = 1280;
    const skipped = [];
    const catalog = createCatalog({
      container,
      onOpen: () => {},
      onSkipCuration: (key) => skipped.push(key),
    });
    catalog.update(photos);
    catalog.setCuration(curationIndex(curation));

    const block = container.findAllByClass('month-picks')[0];
    block.findAllByClass('month-picks-skip')[0].click();
    assert.equal(container.findAllByClass('month-picks').length, 0);
    assert.deepEqual(skipped, ['2026-11']);

    // 切密度会整页重排：跳过状态必须跟着闭包活下来
    catalog.setDensity('compact');
    assert.equal(container.findAllByClass('month-picks').length, 0, '跳过是这一次浏览的决定，不该被重排抹掉');

    // 换了新产物（新 rev）就重新出现：那是「另一份精选」
    catalog.setCuration(curationIndex(curation));
    assert.equal(container.findAllByClass('month-picks').length, 1);
  } finally {
    restore();
  }
});

test('追加批次（滚动加载）不会把已有的块画两遍', () => {
  const { doc, node } = fakeDom();
  const restore = installDom(doc);
  try {
    const photos = [...photosOf(9), ...photosOf(9, { month: 9, prefix: 'q' })];
    const doc2 = docOf([{
      year: 2026, month: 11, count: 9, picks: photosOf(9).map((photo) => photo.id), sentence: '',
    }]);
    const container = node('div');
    container.clientWidth = 1280;
    const catalog = createCatalog({ container, onOpen: () => {}, initialBatch: 9, chunk: 9 });
    catalog.update(photos);
    catalog.setCuration(curationIndex(doc2));
    assert.equal(container.findAllByClass('month-picks').length, 1);

    catalog.more();
    assert.equal(container.findAllByClass('month-picks').length, 1, '追加 9 月不该把 11 月的块再画一个');
  } finally {
    restore();
  }
});

test('curation.js 不碰 DOM：装配只发生在 gallery.js', async () => {
  const source = await readFile(new URL('../js/curation.js', import.meta.url), 'utf8');
  assert.ok(!/\bdocument\./.test(source), '这个模块只做取数与索引');
  assert.ok(!/localStorage/.test(source), '跳过不是设置项，不落盘');
  assert.ok(!/innerHTML/.test(source), '产物文字走 textContent，不拼 HTML');
});
