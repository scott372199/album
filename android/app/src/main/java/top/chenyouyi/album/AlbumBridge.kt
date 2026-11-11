package top.chenyouyi.album

import android.webkit.JavascriptInterface

/**
 * 暴露给网页的原生能力。
 *
 * 方法名是 `src/web/js/native.js` 里硬编码的字符串，改名必须两边一起改；
 * R8 也靠 `proguard-rules.pro` 保住它们，否则 release 包里会静默失效。
 *
 * `addJavascriptInterface` 对**所有**加载进这个 WebView 的页面生效，所以
 * MainActivity 的导航策略必须只放行站点自身与本地资产——否则等于把这三个
 * 方法交给任意网站。
 *
 * Method names are literal strings in `src/web/js/native.js`; rename in both
 * places. R8 keeps them alive via `proguard-rules.pro`. The interface is
 * injected into every document the WebView loads, so MainActivity restricts
 * navigation to our own origin plus local assets.
 */
class AlbumBridge(
    private val onKeepScreenOn: (Boolean) -> Unit,
    private val onReloadSite: () -> Unit,
) {

    /**
     * 屏幕常亮。比网页里的 Screen Wake Lock 可靠：不需要安全上下文，
     * 也不受页面可见性影响。
     *
     * Reliable where the web Wake Lock API is not: no secure-context or
     * page-visibility requirement.
     */
    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
        onKeepScreenOn(on)
    }

    /** 离线页上的「重新加载」；站点地址只在 BuildConfig 里有一份。 */
    @JavascriptInterface
    fun reloadSite() {
        onReloadSite()
    }

    /** 版本串，便于排查「线上页面 + 旧版 APK」这类组合。 */
    @JavascriptInterface
    fun appVersion(): String = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
}
