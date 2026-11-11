/**
 * 原生桥 / Native bridge.
 *
 * 只有安卓 WebView 里 `window.AlbumNative` 才存在（由原生侧
 * `addJavascriptInterface` 注入）。在浏览器里所有函数都是空操作，
 * 所以调用处不需要判断环境。
 *
 * `window.AlbumNative` only exists inside the Android WebView, injected by
 * `addJavascriptInterface`. Every function here is a no-op in a browser, so
 * call sites never branch on environment.
 */

export function hasNativeBridge() {
  return typeof window !== 'undefined' && Boolean(window.AlbumNative);
}

/**
 * 请求原生侧保持/释放屏幕常亮。
 * 返回 true 表示原生接手了——WebView 里的 Wake Lock 常被系统拒绝，
 * 有原生桥时应该优先用它。
 *
 * Returns true when the native side took over: Wake Lock inside a WebView is
 * frequently refused by the system, so the bridge wins when available.
 */
export function setKeepScreenOn(on) {
  if (!hasNativeBridge() || typeof window.AlbumNative.setKeepScreenOn !== 'function') {
    return false;
  }
  try {
    window.AlbumNative.setKeepScreenOn(Boolean(on));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把返回键交给页面自己处理。
 *
 * 两个函数分开是故意的：`__canGoBack()` 是纯查询，`__goBack()` 才动状态。
 * 合成一个「既查询又执行」的函数，以后在别处读到它的人一定会误用。
 * 原生侧建议：`__goBack()` 返回 false 时才 `finish()` 退出 Activity。
 *
 * Two functions on purpose: `__canGoBack()` is a pure query, `__goBack()`
 * mutates. Merging them into "query and act" invites misuse by whoever reads
 * it next. Native side: only call `finish()` when `__goBack()` returns false.
 */
export function installBackBridge({ canGoBack, goBack }) {
  if (typeof window === 'undefined') return;
  window.__canGoBack = () => Boolean(canGoBack());
  window.__goBack = () => Boolean(goBack());
}
