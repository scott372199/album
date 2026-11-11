# 原生桥的方法名是 JS 端硬编码的字符串（window.AlbumNative.setKeepScreenOn 等）。
# R8 一旦重命名或删掉它们，前端调用会静默失败，且只在 release 包上出现——
# 所以这里显式保住整个桥类和所有 @JavascriptInterface 方法。
#
# The JS side calls these by literal name. If R8 renames or strips them the
# calls fail silently and only in release builds, so pin both the class and
# every @JavascriptInterface method.

-keep class top.chenyouyi.album.AlbumBridge { *; }

-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
