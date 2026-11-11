import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 原生桥的测试。模块里引用了 `window`，所以先在全局造一个假的再 import。
 * 这个契约一旦定错，安卓侧（T-24）要跟着改，所以值得钉住。
 *
 * The module touches `window`, so a fake global is installed before import. The
 * contract is shared with the Android shell (T-24); getting it wrong means
 * changing both sides.
 */

const calls = [];
globalThis.window = {
  AlbumNative: {
    setKeepScreenOn: (value) => calls.push(value),
  },
};

const { hasNativeBridge, setKeepScreenOn, installBackBridge } = await import('../js/native.js');

test('有原生桥时能识别出来', () => {
  assert.equal(hasNativeBridge(), true);
});

test('setKeepScreenOn 把布尔值透传给原生侧', () => {
  calls.length = 0;
  assert.equal(setKeepScreenOn(true), true);
  assert.equal(setKeepScreenOn(false), true);
  assert.deepEqual(calls, [true, false]);
});

test('没有原生桥时是空操作，不抛错', () => {
  const saved = globalThis.window.AlbumNative;
  delete globalThis.window.AlbumNative;
  assert.equal(hasNativeBridge(), false);
  assert.equal(setKeepScreenOn(true), false);
  globalThis.window.AlbumNative = saved;
});

test('原生方法抛错时降级为 false，不影响页面', () => {
  const saved = globalThis.window.AlbumNative.setKeepScreenOn;
  globalThis.window.AlbumNative.setKeepScreenOn = () => { throw new Error('bridge gone'); };
  assert.equal(setKeepScreenOn(true), false);
  globalThis.window.AlbumNative.setKeepScreenOn = saved;
});

test('返回桥：查询与执行分开，都是纯真值', () => {
  let handled = 0;
  installBackBridge({
    canGoBack: () => true,
    goBack: () => { handled += 1; return false; },
  });

  // 查询不该有副作用
  assert.equal(globalThis.window.__canGoBack(), true);
  assert.equal(handled, 0);

  // 执行返回 goBack 的结论：false 表示交给原生退出
  assert.equal(globalThis.window.__goBack(), false);
  assert.equal(handled, 1);
});

test('返回桥：无内层状态时返回 false，原生据此退出 Activity', () => {
  installBackBridge({ canGoBack: () => false, goBack: () => false });
  assert.equal(globalThis.window.__canGoBack(), false);
  assert.equal(globalThis.window.__goBack(), false);
});
