import test from 'node:test';
import assert from 'node:assert/strict';
import { heroMediaFailed, watchHeroMedia } from '../js/hero-media.js';

/**
 * 首屏图兜底（线上验收发现：`data/hero.webp` 403，首屏挂着破图）。
 *
 * 三个状态要分清，混在一起就会误判：
 *   - 还没加载完（`complete === false`）→ 不知道，不能藏；
 *   - 加载成功（`complete` 且 `naturalWidth > 0`）→ 正常显示；
 *   - 已失败（`complete` 且 `naturalWidth === 0`）→ 藏掉，走无图状态。
 *
 * 用的是手写假节点，不起浏览器：这里测的是判断与时序，不是渲染。
 * Hand-written fake nodes: the subject is the predicate and the ordering.
 */

/** 一个够用的假 img：只实现这两个属性与两个监听方法 */
function fakeImg({ complete = false, naturalWidth = 0 } = {}) {
  const listeners = new Map();
  return {
    complete,
    naturalWidth,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    /** 测试里手动触发一次事件 */
    fire(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type });
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

test('还没加载完不算失败', () => {
  assert.equal(heroMediaFailed({ complete: false, naturalWidth: 0 }), false);
  assert.equal(heroMediaFailed({ complete: false, naturalWidth: 320 }), false);
});

test('加载成功不算失败', () => {
  assert.equal(heroMediaFailed({ complete: true, naturalWidth: 1600 }), false);
});

test('complete 且宽度为 0 就是失败', () => {
  assert.equal(heroMediaFailed({ complete: true, naturalWidth: 0 }), true);
  assert.equal(heroMediaFailed({ complete: true }), true);
});

test('没有节点时两个函数都不炸', () => {
  assert.equal(heroMediaFailed(null), false);
  assert.equal(typeof watchHeroMedia(null), 'function');
  watchHeroMedia(null)();
});

test('图在脚本之前就失败了：watch 立刻回调一次', () => {
  const img = fakeImg({ complete: true, naturalWidth: 0 });
  let missed = 0;
  watchHeroMedia(img, { onMissing: () => { missed += 1; } });
  assert.equal(missed, 1);
});

test('图正常时 watch 不回调', () => {
  const img = fakeImg({ complete: true, naturalWidth: 1200 });
  let missed = 0;
  watchHeroMedia(img, { onMissing: () => { missed += 1; } });
  assert.equal(missed, 0);
});

test('还没加载完时 watch 先不回调，error 到了才回调', () => {
  const img = fakeImg({ complete: false, naturalWidth: 0 });
  let missed = 0;
  watchHeroMedia(img, { onMissing: () => { missed += 1; } });
  assert.equal(missed, 0);
  img.fire('error');
  assert.equal(missed, 1);
});

test('同一个失败只报一次（error 连发两次）', () => {
  const img = fakeImg({ complete: false });
  let missed = 0;
  watchHeroMedia(img, { onMissing: () => { missed += 1; } });
  img.fire('error');
  img.fire('error');
  assert.equal(missed, 1);
});

test('清理后不再回调，监听也摘掉了', () => {
  const img = fakeImg({ complete: false });
  let missed = 0;
  const stop = watchHeroMedia(img, { onMissing: () => { missed += 1; } });
  assert.equal(img.listenerCount('error'), 1);
  stop();
  assert.equal(img.listenerCount('error'), 0);
  img.fire('error');
  assert.equal(missed, 0);
});

test('不给 onMissing 也不炸', () => {
  const img = fakeImg({ complete: true, naturalWidth: 0 });
  assert.doesNotThrow(() => watchHeroMedia(img)());
});
