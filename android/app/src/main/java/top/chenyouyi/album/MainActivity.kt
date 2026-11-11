package top.chenyouyi.album

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * 唯一的 Activity：一个全屏 WebView 指向线上站点。
 *
 * 为什么不打包前端资产：照片与 HTML 分属两条发布路径（照片由处理函数写，
 * HTML 由 CI 发），把 HTML 打进 APK 会让「改一行样式」变成「发一个 APK」。
 * 壳只负责浏览器做不到的四件事：全屏无地址栏、返回键、选图、屏幕常亮。
 *
 * One activity, one full-bleed WebView pointing at the live site. Bundling the
 * frontend into the APK would turn "change one line of CSS" into "ship an APK",
 * and photos and HTML already ship through separate paths. The shell only adds
 * what a browser cannot: no URL bar, back handling, file picking, keep-awake.
 */
class MainActivity : ComponentActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var updateManager: UpdateManager

    private val siteUrl: String = BuildConfig.SITE_URL
    private val siteHost: String = Uri.parse(BuildConfig.SITE_URL).host.orEmpty()

    /** `onShowFileChooser` 的句柄；用户选完（或取消）必须回填一次，否则页面卡死。 */
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    /** 正停在内置离线页时不再重复加载，也不做更新检查。 */
    private var offline = false

    // 相册一次最多选 30 张：再多就分批，别把用户的内存和刷新率当无限的
    private val pickMedia =
        registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_PICK)) { uris ->
            val callback = fileChooserCallback
            fileChooserCallback = null
            callback?.onReceiveValue(if (uris.isNullOrEmpty()) null else uris.toTypedArray())
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.paper)) }
        webView = WebView(this)
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        applyEdgeToEdge()
        configureWebView()
        installBackHandler()

        updateManager = UpdateManager(this, siteUrl)

        // 旋转屏幕靠 configChanges 自己扛住了，走到这里的恢复只可能是进程重建
        val restored = savedInstanceState?.let { webView.restoreState(it) }
        if (restored == null) loadSite()
    }

    // ---------------------------------------------------------------------
    // 窗口 / window
    // ---------------------------------------------------------------------

    /**
     * 站点是浅色的，系统栏图标必须转深色，否则白底上什么都看不见。
     *
     * 只给 WebView 让出顶部的内边距：状态栏与挖孔都在上面，页面里那个
     * `position: sticky; top: 0` 的导航栏一旦被顶到挖孔底下就会缺一块。
     * 底部不垫——页面自己用 `env(safe-area-inset-bottom)` 和 16~22px 的
     * 留白躲开了手势条。
     *
     * Light-themed site, so the system bar icons must go dark. Only the top
     * inset is applied to the WebView: the sticky nav sits at `top: 0` and would
     * otherwise slide under the cutout. The bottom is left alone — the page
     * already clears the gesture bar with safe-area plus its own margins.
     */
    @Suppress("DEPRECATION")
    private fun applyEdgeToEdge() {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(0, bars.top, 0, 0)
            insets
        }
    }

    // ---------------------------------------------------------------------
    // WebView
    // ---------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        // 小米/OPPO/华为的深色模式会把 WebView 强制反色，照片被压暗——直接关掉。
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
        }

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            // 站内 https + 内置资产，不需要文件系统与 content:// 访问
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            useWideViewPort = true
            loadWithOverviewMode = false
            val baseUa = userAgentString
            userAgentString = "$baseUa AlbumApp/${BuildConfig.VERSION_NAME}"
        }

        webView.setBackgroundColor(getColor(R.color.paper))
        webView.overScrollMode = WebView.OVER_SCROLL_NEVER

        webView.addJavascriptInterface(
            AlbumBridge(
                onKeepScreenOn = ::applyKeepScreenOn,
                onReloadSite = { runOnUiThread { loadSite() } },
            ),
            BRIDGE_NAME,
        )

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = openExternallyIfForeign(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                if (offline) return
                if (url.startsWith(siteUrl)) updateManager.checkIfDue()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                // 子资源失败（某张图裂了）不该把整页换成离线页
                if (request.isForMainFrame && !offline) showOffline()
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                // 4xx 是「这个地址没有」，5xx 才是「服务端现在不行」
                if (request.isForMainFrame &&
                    errorResponse.statusCode >= 500 &&
                    !offline
                ) {
                    showOffline()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                // 上一个回调没回填就再点一次，会让页面永久等在那里
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                return try {
                    pickMedia.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                    )
                    true
                } catch (_: Exception) {
                    fileChooserCallback = null
                    false
                }
            }

            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean = false
        }
    }

    private fun loadSite() {
        offline = false
        webView.loadUrl("$siteUrl/")
    }

    private fun showOffline() {
        offline = true
        applyKeepScreenOn(false)
        webView.loadUrl(OFFLINE_PAGE)
    }

    /**
     * 只放行站点自身，其余一律交给系统浏览器。
     *
     * 这不只是洁癖：原生桥对 WebView 里的**每个**文档生效，随便让它加载
     * 第三方页面等于把 `AlbumNative` 交出去。
     *
     * Only our own origin stays inside; everything else leaves the WebView.
     * This is not cosmetic: the JS bridge is injected into every document, so
     * loading a third-party page would hand it `AlbumNative`.
     */
    private fun openExternallyIfForeign(uri: Uri): Boolean {
        val scheme = uri.scheme.orEmpty().lowercase()
        val host = uri.host.orEmpty()
        if (scheme == "https" && host.equals(siteHost, ignoreCase = true)) return false

        if (scheme == "http" || scheme == "https") {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                .onFailure {
                    Toast.makeText(this, "没有能打开这个链接的应用", Toast.LENGTH_SHORT).show()
                }
        }
        return true
    }

    // ---------------------------------------------------------------------
    // 返回键 / back
    // ---------------------------------------------------------------------

    private fun installBackHandler() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = askPageThenExit()
            },
        )
    }

    /**
     * 先把返回键交给页面（灯箱 → 故事/照片墙 → 退出当前视图），页面没得退
     * 才退出 App。契约见 `src/web/js/native.js`：`__canGoBack()` 只查询，
     * `__goBack()` 才动状态，返回 false 表示「我也没退掉」。
     *
     * Ask the page first; only exit when it reports nothing left to close. See
     * `native.js` for the two-function contract.
     */
    private fun askPageThenExit() {
        if (offline) {
            finish()
            return
        }
        webView.evaluateJavascript(JS_CAN_GO_BACK) { canGo ->
            if (canGo != "true") {
                finish()
                return@evaluateJavascript
            }
            webView.evaluateJavascript(JS_GO_BACK) { handled ->
                if (handled != "true") finish()
            }
        }
    }

    // ---------------------------------------------------------------------
    // 常亮 / keep-awake
    // ---------------------------------------------------------------------

    /**
     * 用窗口标志位而不是 PowerManager 的 WakeLock：不需要权限，也不会因为
     * 忘了释放而持续耗电——Activity 不可见时它自然失效。
     */
    private fun applyKeepScreenOn(on: Boolean) {
        runOnUiThread {
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    // ---------------------------------------------------------------------
    // 生命周期 / lifecycle
    // ---------------------------------------------------------------------

    override fun onPause() {
        super.onPause()
        // 切到后台后照片墙的计时器没有继续跑的理由
        webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            applyKeepScreenOn(false)
            // 先摘出视图树再 destroy，否则部分 ROM 会泄漏 Activity
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val MAX_PICK = 30
        const val BRIDGE_NAME = "AlbumNative"
        const val OFFLINE_PAGE = "file:///android_asset/offline.html"

        // evaluateJavascript 的结果是 JSON，布尔值回来就是 "true"/"false"。
        // 页面没加载完时两个函数都不存在，所以还要挡一层 try。
        const val JS_CAN_GO_BACK =
            "(function(){try{return !!(window.__canGoBack&&window.__canGoBack())}catch(e){return false}})()"
        const val JS_GO_BACK =
            "(function(){try{return !!(window.__goBack&&window.__goBack())}catch(e){return false}})()"
    }
}
