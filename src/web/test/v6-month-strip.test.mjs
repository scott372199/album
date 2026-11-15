import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTH_STRIP_COLLAPSE_WIDTH, MAX_CHIPS, monthKeyOf, monthItems, monthStripPlan,
  labelChips, prefetchTargets, shouldCollapse, createMonthStrip,
} from '../js/month-strip.js';

/**
 * 灯箱同月横条与 chips（V6 T-19）。
 *
 * 重点有三条：同月聚合只按年月（不变量 6 禁止日级粒度）、横条条目必须都在
 * 当前列表里（否则点了跳不动）、窄屏默认收起。
 *
 * Three things matter: month-only grouping (day granularity is forbidden), every
 * strip item must exist in the current list (or clicking does nothing), and the
 * strip starts collapsed on narrow screens.
 */

const p = (id, year = 2026, month = 11, extra = {}) => ({ id, year, month, ratio: 1.5, ...extra });

/* ---------------- 同月聚合 ---------------- */

test('年月键固定两位月份，脏数据返回空串', () => {
  assert.equal(monthKeyOf(p('a', 2026, 3)), '2026-03');
  assert.equal(monthKeyOf(p('a', 2026, 11)), '2026-11');
  assert.equal(monthKeyOf({ id: 'x' }), '');
  assert.equal(monthKeyOf({ id: 'x', year: 2026, month: 0 }), '');
  assert.equal(monthKeyOf({ id: 'x', year: 2026, month: 13 }), '');
  assert.equal(monthKeyOf(null), '');
});

test('同月只按年+月聚合，不同年同月不算同月', () => {
  const photos = [p('a', 2026, 11), p('b', 2026, 12), p('c', 2025, 11), p('d', 2026, 11)];
  assert.deepEqual(monthItems(photos, photos[0]).map((x) => x.id), ['a', 'd']);
});

test('同月照片保持列表原顺序（不是另排一套时间轴）', () => {
  const photos = [p('c', 2026, 11), p('a', 2026, 11), p('b', 2026, 11)];
  assert.deepEqual(monthItems(photos, photos[1]).map((x) => x.id), ['c', 'a', 'b']);
});

test('没有年月的照片不参与横条', () => {
  const photos = [{ id: 'x' }, p('a', 2026, 11)];
  assert.deepEqual(monthItems(photos, { id: 'x' }), []);
  assert.equal(monthStripPlan(photos, 'x').count, 0);
});

test('横条条目不超出上限，避免异常列表把 DOM 撑爆', () => {
  const photos = Array.from({ length: 200 }, (_, i) => p(`id${i}`, 2026, 11));
  assert.equal(monthItems(photos, photos[0], { max: 60 }).length, 60);
});

test('计划里能拿到当前下标，供预取与「滚到当前」用', () => {
  const photos = [p('a'), p('b'), p('c')];
  const plan = monthStripPlan(photos, 'b');
  assert.equal(plan.key, '2026-11');
  assert.equal(plan.count, 3);
  assert.equal(plan.index, 1);
});

test('横条的每一张都在当前列表里——点了必须跳得到', () => {
  const photos = [p('a'), p('b'), p('c', 2026, 12)];
  for (const item of monthItems(photos, photos[0])) {
    assert.ok(photos.some((x) => x.id === item.id), `${item.id} 不在列表里`);
  }
});

/* ---------------- chips ---------------- */

test('chips 只取中文词、去重、按置信度降序', () => {
  const labels = [
    { zh: '山', conf: 80 },
    { zh: '湖', conf: 95 },
    { zh: '山', conf: 99 },
    { en: 'mountain', conf: 99 },
    { zh: '   ', conf: 99 },
    { zh: '云', conf: 70 },
  ];
  assert.deepEqual(labelChips(labels).map((c) => c.zh), ['湖', '山', '云']);
});

test('chips 最多 8 个，缺 conf 的排后面', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ zh: `标签${i}`, conf: i % 2 ? 80 : undefined }));
  const chips = labelChips(many);
  assert.equal(chips.length, MAX_CHIPS);
  assert.ok(chips[0].conf >= chips[chips.length - 1].conf, '置信度必须降序');
  assert.equal(chips[chips.length - 1].conf, 0, '没有置信度的该排在最后');
});

test('没有标签时返回空数组，不编造', () => {
  assert.deepEqual(labelChips(undefined), []);
  assert.deepEqual(labelChips([]), []);
  assert.deepEqual(labelChips([null, {}, { zh: '' }]), []);
});

/* ---------------- 预取与收起 ---------------- */

test('预取左右各两张，跳过自己、视频与没有图的条目', () => {
  const photos = [
    p('a', 2026, 11, { view: 'a/view.webp' }),
    p('b', 2026, 11, { type: 'video', poster: 'b/poster.webp' }),
    p('c', 2026, 11, { view: 'c/view.webp' }),
    p('d', 2026, 11, {}),
    p('e', 2026, 11, { view: 'e/view.webp' }),
    p('f', 2026, 11, { grid: 'f/grid.webp' }),
  ];
  const ids = prefetchTargets(photos, 2, { span: 2 });
  // index 2 是 c：offset 1 撞上视频与没图的条目，offset 2 拿到 a 与 e
  assert.deepEqual(ids, ['a', 'e']);
  assert.ok(!ids.includes('b'), '视频不该被预取');
  assert.ok(!ids.includes('c'), '自己不该被预取');
});

test('下标越界时预取返回空，不报错', () => {
  assert.deepEqual(prefetchTargets([], 0), []);
  assert.deepEqual(prefetchTargets([p('a')], -1), []);
});

test('窄屏默认收起，按断点分档', () => {
  assert.equal(shouldCollapse(390), true);
  assert.equal(shouldCollapse(MONTH_STRIP_COLLAPSE_WIDTH - 1), true);
  assert.equal(shouldCollapse(MONTH_STRIP_COLLAPSE_WIDTH), false);
  assert.equal(shouldCollapse(1440), false);
  assert.equal(shouldCollapse(0), true);
  assert.equal(shouldCollapse(undefined), true);
});

/* ---------------- DOM 装配 ---------------- */

/** 够用的假 DOM：createElement + 属性 + 子节点 + addEventListener/click */
function fakeDom() {
  const node = (tag) => ({
    tagName: tag,
    children: [],
    dataset: {},
    attrs: {},
    listeners: {},
    hidden: false,
    className: '',
    textContent: '',
    classList: {
      set: new Set(),
      add(name) { this.set.add(name); },
      toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); },
      contains(name) { return this.set.has(name); },
    },
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
    querySelector(sel) {
      const want = sel.replace('.', '');
      const walk = (n) => {
        for (const c of n.children) {
          if ((c.className || '').split(' ').includes(want)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
  });
  const doc = {
    createElement: node,
    createDocumentFragment: () => Object.assign(node('#fragment'), { isFragment: true }),
  };
  return { doc, node };
}

test('装配：窄屏默认收起、宽屏展开，换月重新决定', () => {
  const { doc, node } = fakeDom();
  const host = node('div');
  let width = 390;
  const strip = createMonthStrip({ host, doc, wide: () => width });

  strip.render([p('a'), p('b')], p('a'));
  assert.equal(host.dataset.collapsed, 'true', '窄屏该收起');
  assert.equal(host.hidden, false);

  const toggle = host.children[0].children[0];
  assert.equal(toggle.textContent, '本月 2 张 · 展开');
  toggle.click();
  assert.equal(host.dataset.collapsed, 'false');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  // 同月内翻一张，不该又被收起来
  strip.render([p('a'), p('b')], p('b'));
  assert.equal(host.dataset.collapsed, 'false');

  // 换到另一个月：那张月里只有它自己、也没有 chips → 整块隐藏，不留空行
  width = 1440;
  strip.render([p('a'), p('b'), p('c', 2026, 12)], p('c', 2026, 12));
  assert.equal(host.hidden, true);
});

test('装配：没有同月邻张也没有标签时整块隐藏，不留空行', () => {
  const { doc, node } = fakeDom();
  const host = node('div');
  const strip = createMonthStrip({ host, doc, wide: () => 1440 });
  strip.render([p('a')], p('a'), []);
  assert.equal(host.hidden, true);
});

test('装配：点横条回调 id，点 chip 回调中文词', () => {
  const { doc, node } = fakeDom();
  const host = node('div');
  const picked = [];
  const chips = [];
  const strip = createMonthStrip({
    host, doc, wide: () => 1440,
    onPick: (id) => picked.push(id),
    onChip: (term) => chips.push(term),
  });
  strip.render([p('a'), p('b')], p('a'), [{ zh: '湖', conf: 90 }]);
  host.children[1].children[1].click();
  assert.deepEqual(picked, ['b']);
  host.children[2].children[0].click();
  assert.deepEqual(chips, ['湖']);
});
