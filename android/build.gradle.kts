// 插件版本集中在这里，app/build.gradle.kts 只 apply 不写版本号。
// Plugin versions live here; the app module only applies them.

plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
