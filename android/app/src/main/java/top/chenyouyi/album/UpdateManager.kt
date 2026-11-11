package top.chenyouyi.album

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * 应用内更新。
 *
 * 站点根目录（`apk/version.json`）是唯一真相：APK 与清单一起由
 * `scripts/publish-apk.mjs` 发上去，客户端只比对 versionCode。
 *
 * 下载不用 `DownloadManager`：它把文件写进公共下载目录，拿回来是个
 * content:// URI，要算 sha256 得再整份读一遍，而且校验失败时那份文件还留在
 * 外面。这里自己下到 app 私有目录、边下边算摘要，校验不过就删——「先校验
 * 再安装」才是要的语义。
 *
 * The version manifest at `apk/version.json` is the single source of truth.
 * Downloads deliberately bypass `DownloadManager`: it writes to the public
 * Downloads collection, returns a content:// handle whose bytes must be read
 * again for hashing, and leaves the file behind when verification fails.
 * Streaming into app-private storage lets us hash while downloading and delete
 * on mismatch — verify first, install second.
 */
class UpdateManager(
    private val activity: Activity,
    private val siteUrl: String,
) {

    private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile
    private var checking = false

    private data class Release(
        val versionCode: Int,
        val versionName: String,
        val url: String,
        val sha256: String,
        val notes: String,
    )

    /**
     * 页面加载完成时调用。检查频率有上限——每次进 App 都打一次清单纯属浪费，
     * 而 `apk/version.json` 本身也是走 CDN 的。
     *
     * Called once a page finishes loading. Throttled: the manifest sits behind
     * the same CDN, so polling on every launch buys nothing.
     */
    fun checkIfDue() {
        val now = System.currentTimeMillis()
        if (checking) return
        if (now - prefs.getLong(KEY_LAST_CHECK, 0L) < CHECK_INTERVAL_MS) return
        checking = true

        thread(name = "album-update-check", isDaemon = true) {
            try {
                val release = fetchManifest()
                // 只有查询成功才记时间；失败（多半是断网）留着重试的机会
                prefs.edit().putLong(KEY_LAST_CHECK, now).apply()
                if (release.versionCode > BuildConfig.VERSION_CODE) {
                    activity.runOnUiThread { prompt(release) }
                }
            } catch (_: Exception) {
                // 更新检查失败不该打扰任何人，静默跳过
            } finally {
                checking = false
            }
        }
    }

    // ---------------------------------------------------------------------
    // 清单 / manifest
    // ---------------------------------------------------------------------

    private fun fetchManifest(): Release {
        // 带上时间戳：清单是「必须最新」的那类文件，宁可绕过 CDN 缓存
        val url = URL("$siteUrl/apk/version.json?t=${System.currentTimeMillis()}")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 8000
            readTimeout = 8000
            setRequestProperty("Cache-Control", "no-cache")
        }
        try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("version.json HTTP ${conn.responseCode}")
            }
            val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val apkUrl = json.getString("url")

            // 更新包必须来自本站。否则「校验 sha256」只是在替别人的服务器
            // 核对它自己给的哈希，等于没校验。
            if (!apkUrl.startsWith("$siteUrl/")) {
                throw IOException("更新地址不在本站：$apkUrl")
            }

            return Release(
                versionCode = json.getInt("versionCode"),
                versionName = json.optString("versionName", ""),
                url = apkUrl,
                sha256 = json.optString("sha256", "").trim().lowercase(),
                notes = json.optString("notes", "").trim(),
            )
        } finally {
            conn.disconnect()
        }
    }

    // ---------------------------------------------------------------------
    // 提示与下载 / prompt & download
    // ---------------------------------------------------------------------

    private fun prompt(release: Release) {
        if (activity.isFinishing || activity.isDestroyed) return

        val message = buildString {
            append("当前 ")
            append(BuildConfig.VERSION_NAME)
            append("，最新 ")
            append(release.versionName.ifBlank { release.versionCode.toString() })
            if (release.notes.isNotBlank()) {
                append("\n\n")
                append(release.notes)
            }
        }

        AlertDialog.Builder(activity)
            .setTitle("有新版本")
            .setMessage(message)
            .setNegativeButton("以后再说", null)
            .setPositiveButton("更新") { _, _ -> startDownload(release) }
            .show()
    }

    private fun startDownload(release: Release) {
        if (!canInstallPackages()) {
            Toast.makeText(activity, "请先允许本应用安装应用", Toast.LENGTH_LONG).show()
            runCatching {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}"),
                    ),
                )
            }
            return
        }

        val (dialog, bar) = buildProgressDialog()
        dialog.show()

        thread(name = "album-update-download", isDaemon = true) {
            try {
                val apk = downloadApk(release) { done, total ->
                    if (total <= 0) return@downloadApk
                    activity.runOnUiThread {
                        bar.isIndeterminate = false
                        bar.progress = ((done * 100) / total).toInt()
                    }
                }
                activity.runOnUiThread {
                    dialog.dismiss()
                    install(apk)
                }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    dialog.dismiss()
                    Toast.makeText(activity, "更新失败：${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun canInstallPackages(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            activity.packageManager.canRequestPackageInstalls()

    private fun buildProgressDialog(): Pair<AlertDialog, ProgressBar> {
        val density = activity.resources.displayMetrics.density
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            max = 100
        }
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((24 * density).toInt(), (20 * density).toInt(), (24 * density).toInt(), 0)
            addView(
                bar,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
        val dialog = AlertDialog.Builder(activity)
            .setTitle("正在下载更新")
            .setView(box)
            .setCancelable(false)
            .create()
        return dialog to bar
    }

    /**
     * 边下边算 sha256，写完才改名；中途失败留下的是 `.part`，下次会被清掉。
     * Hash while streaming, rename only when complete; a partial file stays as
     * `.part` and is removed on the next attempt.
     */
    private fun downloadApk(release: Release, onProgress: (Long, Long) -> Unit): File {
        val dir = File(activity.getExternalFilesDir(null) ?: activity.filesDir, "apk")
        if (!dir.exists() && !dir.mkdirs()) throw IOException("无法创建下载目录")
        dir.listFiles()?.forEach { if (it.name.endsWith(PART_SUFFIX)) it.delete() }

        val target = File(dir, "album-${release.versionCode}.apk")
        val part = File(dir, target.name + PART_SUFFIX)
        target.delete()
        part.delete()

        val digest = MessageDigest.getInstance("SHA-256")
        val conn = (URL(release.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 30000
        }
        try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("APK HTTP ${conn.responseCode}")
            }
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        out.write(buf, 0, read)
                        digest.update(buf, 0, read)
                        done += read
                        onProgress(done, total)
                    }
                }
            }
        } finally {
            conn.disconnect()
        }

        val actual = digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        if (release.sha256.isNotBlank() && actual != release.sha256) {
            part.delete()
            throw IOException("校验失败（期望 ${release.sha256.take(12)}…，实际 ${actual.take(12)}…）")
        }
        if (!part.renameTo(target)) {
            part.delete()
            throw IOException("无法保存安装包")
        }
        return target
    }

    private fun install(apk: File) {
        val uri = FileProvider.getUriForFile(
            activity,
            "${activity.packageName}.fileprovider",
            apk,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { activity.startActivity(intent) }
            .onFailure { Toast.makeText(activity, "无法调起安装器", Toast.LENGTH_LONG).show() }
    }

    private companion object {
        const val PREFS = "album-update"
        const val KEY_LAST_CHECK = "lastCheck"
        const val PART_SUFFIX = ".part"

        /** 6 小时。手动重装会重置，改版本号后不必等。 */
        const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
    }
}
