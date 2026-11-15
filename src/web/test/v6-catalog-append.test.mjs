import test from 'node:test';
import assert from 'node:assert/strict';
import { planCatalog, yearKey, diffYears, createCatalog } from '../js/gallery.js';

/**
 * V6 T-08：时间轴增量渲染的正确性。
 *
 * `createCatalog.more()` 原来每次调用都 `container.replaceChildren()` 整页重建，
 * 滚到第 N 批时总 DOM 工作是 O(N²)。改成追加之后，风险从「慢」变成「画错」：
 * 追加出来的结构和一次性重排必须**逐字段全等**，否则滚动一下版式就变了。
 *
 * 因此把布局抽成纯计划（`planCatalog`），让两条路径都消费它，然后在这里
 * 用同一个 diff/apply 逻辑模拟「逐批追加」，与一次性重排的结果 deepEqual 比对。
 * 本仓库没有 jsdom，DOM 那层只负责照着计划 appendChild，所以计划相等即结构相等。
 *
 * `more()` 改成增量追加后，正确性风险从「慢」变成「画错」——所以核心断言是
 * 追加结果与一次性重排逐字段相等。夹具只用无意义的占位 id。
 */

/* ---------- 确定性夹具 / Deterministic fixture ---------- */

/** 线性同余，保证任何机器上序列一致 / LCG so the sequence is identical everywhere */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const MONTHS = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/**
 * 按「日期倒序」造照片：先造新年，再造旧年，年内先造大月。
 * 每张只带布局需要的字段，id 是定长占位串。
 */
function makePhotos({ years, perYear, seed = 20260101 }) {
  const rand = lcg(seed);
  const photos = [];
  let n = 0;
  for (const year of years) {
    const perMonth = Math.ceil(perYear / 4);
    let made = 0;
    for (const month of MONTHS) {
      for (let i = 0; i < perMonth && made < perYear; i += 1) {
        n += 1;
        const ratio = 0.62 + rand() * 1.1;         // 竖图 ~0.62，横图 ~1.7
        const roll = rand();
        const type = roll < 0.08 ? 'video' : roll < 0.12 ? 'live' : 'image';
        const id = `p${String(n).padStart(4, '0')}`;
        photos.push({
          id,
          year,
          month,
          ratio: Math.round(ratio * 100) / 100,
          type,
          featured: rand() < 0.06,
          // 让 img 的 src / srcset / sizes / alt 也进入结构比对
          grid: `${id}/grid.webp`,
          thumb: `${id}/thumb.webp`,
          view: `${id}/view.webp`,
        });
        made += 1;
      }
      if (made >= perYear) break;
    }
  }
  return photos;
}

/**
 * 逐批追加的模拟：与 `createCatalog` 内部的 diff/apply 完全同一套动作
 * （保留前缀 → 删掉尾部 → 追加重建），只是把 DOM 换成数组。
 */
function simulateAppend(photos, { batch, width }) {
  let limit = 0;
  let rendered = [];
  let keys = [];
  const trace = [];

  while (limit < photos.length) {
    limit = Math.min(limit + batch, photos.length);
    const plan = planCatalog(photos.slice(0, limit), width);
    const { keep, rebuild, stale } = diffYears(keys, plan.years);
    rendered = rendered.slice(0, keep).concat(rebuild);
    keys = keys.slice(0, keep).concat(rebuild.map(yearKey));
    trace.push({
      limit,
      keep,
      rebuild: rebuild.length,
      stale,
      sections: rendered.length,
      tiles: countTiles(rendered),
    });
  }

  return { rendered, trace };
}

const countTiles = (years) => years.reduce((sum, y) => (
  sum + y.rows.reduce((s, row) => s + (row.kind === 'row' ? row.tiles.length : 0), 0)
), 0);

const WIDTH = 1280;

/* ---------- 核心：等价性 ---------- */

test('180 张 / 3 年 / chunk=60（批次正好落在年交界）：逐批追加与一次性重排全等', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 60 });
  assert.equal(photos.length, 180);

  const full = planCatalog(photos, WIDTH);
  assert.equal(full.years.length, 3);

  const { rendered, trace } = simulateAppend(photos, { batch: 60, width: WIDTH });

  // 最关键的一条：批次边界卡在年交界上时，前两年应当原样保留，只新建当年
  assert.deepEqual(trace.map((t) => [t.keep, t.rebuild]), [[0, 1], [1, 1], [2, 1]]);
  assert.deepEqual(rendered, full.years);
});

test('批次切在年内（chunk=40）：仍与一次性重排全等', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 60 });
  const full = planCatalog(photos, WIDTH);
  const { rendered, trace } = simulateAppend(photos, { batch: 40, width: WIDTH });

  // 年内切分意味着最后一年要反复重建——这是允许的，只是多花那几年的重排
  assert.ok(trace.some((t) => t.rebuild === 1 && t.keep >= 1));
  assert.deepEqual(rendered, full.years);
});

test('容器子节点数与瓦片数只增不减', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 60 });
  const { trace } = simulateAppend(photos, { batch: 50, width: WIDTH });

  for (let i = 1; i < trace.length; i += 1) {
    assert.ok(trace[i].sections >= trace[i - 1].sections, `第 ${i} 批年分组数回退了`);
    assert.ok(trace[i].tiles >= trace[i - 1].tiles, `第 ${i} 批瓦片数回退了`);
  }
  assert.equal(trace.at(-1).tiles, photos.length);
});

test('同一份可见列表重复追加：零重建、零删除', () => {
  const photos = makePhotos({ years: [2025, 2024], perYear: 40 });
  const plan = planCatalog(photos, WIDTH);
  const keys = plan.years.map(yearKey);

  assert.deepEqual(diffYears(keys, planCatalog(photos, WIDTH).years),
    { keep: plan.years.length, rebuild: [], stale: 0 });

  // 少了照片也算变化：没动过的年保留，被改动的那年及其后全部重建
  const shrunk = diffYears(keys, planCatalog(photos.slice(0, 60), WIDTH).years);
  assert.equal(shrunk.keep, 1);
  assert.equal(shrunk.rebuild.length, 1);
  assert.equal(shrunk.stale, 1);
});

test('新照片插到最前（年份顺序被打乱）：从第一处不同整段重建，结果仍与全量一致', () => {
  const base = makePhotos({ years: [2024, 2023], perYear: 30 });
  const head = makePhotos({ years: [2026], perYear: 10, seed: 7 });

  const before = planCatalog(base, WIDTH);
  const after = planCatalog([...head, ...base], WIDTH);
  const { keep, rebuild } = diffYears(before.years.map(yearKey), after.years);

  assert.equal(keep, 0, '第一年就变了，不能保留任何前缀');
  assert.equal(rebuild.length, after.years.length);
  assert.deepEqual(before.years.slice(0, keep).concat(rebuild), after.years);
});

/* ---------- 逐字段校验：月张数、偏移量、行几何 ---------- */

test('月标题张数等于该月实际张数（一次计数替掉原来的 flat.filter 循环）', () => {
  const photos = makePhotos({ years: [2025, 2024], perYear: 48 });
  const plan = planCatalog(photos, WIDTH);

  for (const yearPlan of plan.years) {
    const titles = yearPlan.rows.filter((r) => r.kind === 'month');
    const actual = new Map();
    for (const id of yearPlan.ids) {
      const month = photos.find((p) => p.id === id).month;
      actual.set(month, (actual.get(month) || 0) + 1);
    }
    let sum = 0;
    for (const title of titles) {
      assert.equal(title.count, actual.get(title.month), `${yearPlan.year} 年 ${title.month} 月张数不对`);
      sum += title.count;
    }
    assert.equal(sum, yearPlan.total, '月标题张数之和应等于该年总数');
    assert.equal(yearPlan.total, yearPlan.ids.length);
  }
});

test('瓦片 index 连续覆盖 0..n-1，灯箱按下标取图不会错位', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 24 });
  const plan = planCatalog(photos, WIDTH);
  const seen = [];

  for (const yearPlan of plan.years) {
    for (const row of yearPlan.rows) {
      if (row.kind !== 'row') continue;
      for (const tile of row.tiles) seen.push(tile);
    }
  }

  assert.deepEqual(seen.map((t) => t.index), seen.map((_, i) => i));
  assert.equal(new Set(seen.map((t) => t.id)).size, photos.length);
});

test('行几何与旧的 createRow 公式一致', () => {
  const photos = makePhotos({ years: [2025], perYear: 30 });
  const plan = planCatalog(photos, WIDTH);
  const byId = new Map(photos.map((p) => [p.id, p]));
  let featureRows = 0;
  let stripRows = 0;

  for (const yearPlan of plan.years) {
    for (const row of yearPlan.rows) {
      if (row.kind !== 'row') continue;
      if (row.type === 'feature') featureRows += 1; else stripRows += 1;
      for (const tile of row.tiles) {
        const ratio = Number(byId.get(tile.id).ratio) || 1;
        const natural = row.height * ratio;
        const expectedWidth = row.type === 'feature' ? Math.min(natural, WIDTH) : natural;
        const expectedHeight = row.type === 'feature'
          ? Math.min(row.height, expectedWidth / ratio)
          : row.height;
        assert.equal(tile.width, expectedWidth);
        assert.equal(tile.height, expectedHeight);
        assert.equal(tile.kind, row.type === 'feature' ? 'feature' : 'thumb');
      }
    }
  }

  assert.ok(featureRows > 0 && stripRows > 0, '夹具应同时覆盖大图行与并排行');
});

/* ---------- 伪 DOM：真的把树建出来比一遍 ---------- */

/**
 * 计划级相等只是间接证据——DOM 那层还可能画错。这里给一个 70 行的伪 DOM，
 * 让 `createCatalog` 真的跑起来，把整棵树序列化成文本逐行比对。
 *
 * 只用 `src/web/js/` 里确实用到的那几个 API；不引入 jsdom（依赖体积换不来更多信息）。
 */
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    attrs: {},
    dataset: {},
    classList: null,
    style: null,
    innerHTML: '',
    textContent: '',
  };
  const classes = new Set();
  node.classList = {
    add: (...names) => names.forEach((n) => n && classes.add(n)),
    contains: (n) => classes.has(n),
    get value() { return [...classes].join(' '); },
  };
  node.style = { setProperty: (key, value) => { node.style[key] = value; } };
  node.setAttribute = (key, value) => { node.attrs[key] = String(value); };
  node.getAttribute = (key) => (key in node.attrs ? node.attrs[key] : null);
  node.addEventListener = () => {};
  node.appendChild = (child) => {
    if (child?.isFragment) {
      for (const grand of [...child.childNodes]) node.appendChild(grand);
      child.childNodes.length = 0;
      return child;
    }
    child.parentNode = node;
    node.childNodes.push(child);
    return child;
  };
  node.remove = () => {
    const host = node.parentNode;
    if (!host) return;
    host.childNodes = host.childNodes.filter((c) => c !== node);
    node.parentNode = null;
  };
  node.replaceChildren = (...children) => {
    for (const child of node.childNodes) child.parentNode = null;
    node.childNodes = [];
    for (const child of children) node.appendChild(child);
  };
  node.querySelector = (selector) => {
    const want = selector.replace(/^\./, '');
    const walk = (parent) => {
      for (const child of parent.childNodes) {
        if (child.classList?.contains(want)) return child;
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(node);
  };
  Object.defineProperty(node, 'className', {
    set(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    },
    get() { return node.classList.value; },
  });
  return node;
}

const observers = [];
const created = { total: 0, byTag: {} };

function installFakeDom(container) {
  created.total = 0;
  created.byTag = {};
  globalThis.document = {
    // 顺手数一下建了多少节点：增量渲染的收益就是「每个瓦片只建一次」，
    // 这件事能精确断言，比测耗时稳
    createElement: (tag) => {
      created.total += 1;
      created.byTag[tag] = (created.byTag[tag] || 0) + 1;
      return makeNode(tag);
    },
    createDocumentFragment: () => {
      const frag = makeNode('#fragment');
      frag.isFragment = true;
      return frag;
    },
  };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  container.clientWidth = WIDTH;
}

/** 把树序列化成文本：只比结构上真正影响渲染的字段 */
function serialize(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const bits = [node.tagName];
  if (node.className) bits.push(`.${String(node.className).split(/\s+/).join('.')}`);
  // data-id / data-index 走的是 dataset，不是 attribute——灯箱下标就靠它
  for (const key of ['id', 'index']) {
    if (node.dataset?.[key] != null) bits.push(`data-${key}=${node.dataset[key]}`);
  }
  for (const key of ['data-id', 'data-index']) {
    if (key in node.attrs) bits.push(`${key}=${node.attrs[key]}`);
  }
  for (const key of ['width', 'height', 'backgroundImage']) {
    if (node.style[key] != null && key !== 'backgroundImage') bits.push(`${key}:${node.style[key]}`);
    if (node.style[key] && key === 'backgroundImage') bits.push(`bg:${node.style[key]}`);
  }
  for (const key of ['src', 'sizes', 'loading', 'srcset', 'alt', 'role']) {
    if (node[key]) bits.push(`${key}=${node[key]}`);
  }
  if (node.attrs.role) bits.push(`role=${node.attrs.role}`);
  if (node.attrs['aria-label']) bits.push(`aria=${node.attrs['aria-label']}`);
  if (node.attrs['aria-hidden']) bits.push('hidden');
  if (node.tabIndex != null) bits.push(`tab=${node.tabIndex}`);
  if (node.textContent) bits.push(`text=${node.textContent}`);
  if (node.innerHTML) bits.push(`html=${node.innerHTML}`);

  const head = `${pad}${bits.join(' ')}`;
  if (!node.childNodes.length) return head;
  return [head, ...node.childNodes.map((child) => serialize(child, depth + 1))].join('\n');
}

function withFakeDom(fn) {
  const container = makeNode('div');
  installFakeDom(container);
  observers.length = 0;
  try {
    return fn(container, () => observers.at(-1), created);
  } finally {
    delete globalThis.document;
    delete globalThis.ResizeObserver;
    delete globalThis.requestAnimationFrame;
  }
}

test('伪 DOM：逐批 more() 建出的树与一次性全量渲染逐行全等（批次落在年交界）', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 60 });

  withFakeDom((container) => {
    const batch = createCatalog({ container, onOpen: () => {}, initialBatch: 60, chunk: 60 });
    batch.update(photos);
    batch.more();
    batch.more();
    const incremental = serialize(container);
    const sectionsAfter = container.childNodes.length;
    batch.destroy();

    const fresh = makeNode('div');
    fresh.clientWidth = WIDTH;
    const full = createCatalog({ container: fresh, onOpen: () => {}, initialBatch: 180, chunk: 60 });
    full.update(photos);
    full.destroy();

    assert.equal(incremental, serialize(fresh));
    assert.equal(sectionsAfter, 3);
  });
});

test('伪 DOM：批次切在年内时，被重建的年份不会留下重复节点', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 60 });

  withFakeDom((container) => {
    // 60 / 35 的批次边界必然切在年内，才会真的走到「删掉旧年份再重建」
    const catalog = createCatalog({ container, onOpen: () => {}, initialBatch: 60, chunk: 35 });
    catalog.update(photos);
    while (catalog.more());
    const incremental = serialize(container);
    assert.equal(container.childNodes.length, 3, `年份节点数不对：${container.childNodes.length}`);
    catalog.destroy();

    const fresh = makeNode('div');
    fresh.clientWidth = WIDTH;
    const full = createCatalog({ container: fresh, onOpen: () => {}, initialBatch: 180, chunk: 60 });
    full.update(photos);
    full.destroy();

    assert.equal(incremental, serialize(fresh));
  });
});

test('伪 DOM：追加以外的年份节点保持同一个对象（没有偷偷重建）', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 60 });

  withFakeDom((container) => {
    const catalog = createCatalog({ container, onOpen: () => {}, initialBatch: 60, chunk: 60 });
    catalog.update(photos);

    const before = [...container.childNodes];
    catalog.more();
    const after = [...container.childNodes];

    assert.equal(after[0], before[0], '第一年的节点被重建了');
    assert.equal(after.length, 2);
    assert.notEqual(after[1], before[0]);
    catalog.destroy();
  });
});

test('伪 DOM：宽度不变时 ResizeObserver 不触发全量重排；宽度变了才重排', () => {
  const photos = makePhotos({ years: [2025, 2024], perYear: 40 });

  withFakeDom((container, lastObserver) => {
    const catalog = createCatalog({ container, onOpen: () => {}, initialBatch: 40, chunk: 40 });
    catalog.update(photos);

    const first = container.childNodes[0];
    // 追加内容会让容器变高：只改了高度，宽度没变 → 不应该重排
    lastObserver().callback();
    assert.equal(container.childNodes[0], first, '高度变化不该引发全量重排');

    // 真的换宽度了 → 重排
    container.clientWidth = 900;
    lastObserver().callback();
    assert.notEqual(container.childNodes[0], first, '宽度变化必须重排');
    catalog.destroy();
  });
});

test('伪 DOM：滚完全程每张照片只建一次 figure（原来每批都整页重建）', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023], perYear: 60 });

  withFakeDom((container, lastObserver, created) => {
    const catalog = createCatalog({ container, onOpen: () => {}, initialBatch: 60, chunk: 60 });
    catalog.update(photos);
    while (catalog.more());

    // 旧实现三批分别建 60 + 120 + 180 = 360 个 figure；现在正好 180 个
    assert.equal(created.byTag.figure, photos.length);
    catalog.destroy();
  });
});

/* ---------- 性能代理 ---------- */

test('500 张时单次计划计算 ≤50ms（Node 代理；浏览器 long task 需真机复测）', () => {
  const photos = makePhotos({ years: [2025, 2024, 2023, 2022], perYear: 125 });
  assert.equal(photos.length, 500);

  let best = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const start = process.hrtime.bigint();
    planCatalog(photos, WIDTH);
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }

  assert.ok(best < 50, `500 张计划计算耗时 ${best.toFixed(1)}ms，超过 50ms`);
});
