import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// 版本号：唯一来源是 version.properties。
// Version comes from version.properties and nowhere else.
// ---------------------------------------------------------------------------
val versionProps = Properties().apply {
    file("version.properties").inputStream().use { load(it) }
}
val appVersionCode = versionProps.getProperty("versionCode")!!.trim().toInt()
val appVersionName = versionProps.getProperty("versionName")!!.trim()

// ---------------------------------------------------------------------------
// 签名：只从 android/keystore.properties 读，该文件与 keystore 都不入库。
// 文件不存在时 release 产出未签名包（app-release-unsigned.apk），不做假签名。
//
// Signing material is read from android/keystore.properties, which is never
// committed. Without it the release build simply stays unsigned — we do not
// fall back to the debug key, because an app signed with the debug key cannot
// be updated in place later.
// ---------------------------------------------------------------------------
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
val hasReleaseKey = !keystoreProps.getProperty("storeFile").isNullOrBlank()

android {
    namespace = "top.chenyouyi.album"
    compileSdk = 35

    defaultConfig {
        applicationId = "top.chenyouyi.album"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        // 站点地址构建期注入 / site origin injected at build time
        val siteUrl = providers.gradleProperty("album.siteUrl")
            .getOrElse("https://photos.chenyouyi.top")
            .trimEnd('/')
        buildConfigField("String", "SITE_URL", "\"$siteUrl\"")
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile")!!)
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            // 便于和正式版并存排查？暂时不需要，包名保持一致更容易解释。
            // Keep the same applicationId for both; one install at a time.
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/*.version",
        )
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // 用来关掉 ROM 强制的 WebView 算法暗色，否则小米/OPPO 的深色模式会把
    // 照片压暗、把白底压成灰底——违反「不加滤镜、不改色彩」。
    // Used to disable forced algorithmic darkening, which several Chinese ROMs
    // apply to WebViews even when the page declares a light theme.
    implementation("androidx.webkit:webkit:1.12.1")
}
