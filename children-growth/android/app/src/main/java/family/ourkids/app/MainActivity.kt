package family.ourkids.app

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView.HitTestResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import family.ourkids.app.net.ApiServer

/**
 * 套壳主界面：单个 Activity + 一个 WebView。
 * 页面全部来自 assets/www，不走网络域名，因此不需要任何原生页面代码。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var bar: ProgressBar
    private var pendingFile: ValueCallback<Array<Uri>>? = null

    /** 本地 API：把 Room 里的数据以 API 路由形式提供给 WebView */
    private val api by lazy { ApiServer(this) }

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            val parsed = WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
            val fallback = when {
                data?.clipData != null -> Array(data.clipData!!.itemCount) { i -> data.clipData!!.getItemAt(i).uri }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
            val selected = parsed?.takeIf { it.isNotEmpty() } ?: fallback
            if (selected != null) api.importFiles(selected.toList())
            pendingFile?.onReceiveValue(selected)
            pendingFile = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        val root = FrameLayout(this)
        web = WebView(this)
        bar = ProgressBar(this).apply { visibility = View.VISIBLE }

        root.addView(web, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(
            bar,
            FrameLayout.LayoutParams(dp(28), dp(28)).apply { gravity = Gravity.CENTER }
        )
        setContentView(root)

        // 状态栏与手势条区域让出来，页面里固定的 44px 顶栏才不会被遮住
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(0, bars.top, 0, bars.bottom)
            insets
        }

        setupWeb()
        web.loadUrl(START_URL)

        // 加载失败时也不让转圈一直挂着
        bar.postDelayed({ bar.visibility = View.GONE }, 5000)

        handleBack()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWeb() {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true   // 视频必须点一下才播
            useWideViewPort = true
            loadWithOverviewMode = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
        }
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.bg))
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isVerticalScrollBarEnabled = false

        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                // /api/* 交给本地数据接口，其余静态资源仍由 assets 提供
                if (url.host == ASSET_HOST && (url.path ?: "").startsWith("/api/")) {
                    return api.handle(request)
                }
                if (url.host == ASSET_HOST && (url.path ?: "").startsWith("/media/")) {
                    return api.media(url.path ?: "")
                }
                return loader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val host = request.url.host ?: return false
                return if (host == ASSET_HOST) {
                    false
                } else {
                    // 站外链接交给系统浏览器，壳里不做站内跳转
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    true
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                bar.visibility = View.GONE
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                pendingFile?.onReceiveValue(null)
                pendingFile = filePathCallback
                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "image/*"
                }
                return runCatching { fileChooser.launch(intent); true }.getOrElse {
                    pendingFile = null
                    false
                }
            }
        }

        // 长按图片 → 存到相册（长辈最常用的一个动作）
        web.setOnLongClickListener {
            val r = web.hitTestResult
            if (r.type == HitTestResult.IMAGE_TYPE || r.type == HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
                val url = r.extra
                if (!url.isNullOrBlank() && url.startsWith("http")) {
                    confirmSave(url)
                    true
                } else false
            } else false
        }
    }

    private fun confirmSave(url: String) {
        AlertDialog.Builder(this)
            .setTitle("保存这张照片")
            .setMessage("会存到相册的「我们的孩子」里。")
            .setNegativeButton("取消", null)
            .setPositiveButton("保存") { _, _ -> download(url) }
            .show()
    }

    private fun download(url: String) {
        val name = "our-kids-${System.currentTimeMillis()}.jpg"
        val base = DownloadManager.Request(Uri.parse(url))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setTitle("保存照片")

        val req = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            base.setDestinationInExternalPublicDir(Environment.DIRECTORY_PICTURES, "我们的孩子/$name")
        } else {
            base.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_PICTURES, name)
        }

        runCatching {
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            Toast.makeText(this, "已开始保存，稍后在相册里", Toast.LENGTH_LONG).show()
        }.onFailure {
            Toast.makeText(this, "保存失败，试试长按图片另存", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleBack() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_HOST/assets/www/home.html"
    }
}
