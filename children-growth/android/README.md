# 我们的孩子 · Android 套壳工程

一个 Activity + 一个 WebView 的壳工程，界面全部来自 `assets/www` 里的同一套 HTML。
改网页不用动原生代码，重新打包即可。

除了壳，还带了一层**最小可用的本地数据层**：Room 存照片索引与故事草稿，
`/api/*` 以本地 HTTP 的形式给页面用。「上传确认页」读的是数据库，接受/改名会真的写回去。

## 环境

- Android Studio Koala（或更新）
- JDK 17
- compileSdk 34 / minSdk 26 / targetSdk 34
- AGP 8.5.2 + Gradle 8.7 + Kotlin 1.9.24 + KSP 1.9.24-1.0.20
- Room 2.6.1

## 运行

1. Android Studio → Open → 选择本目录 `android/`
2. 首次同步会自己下载 Gradle 与依赖（本仓库没有带 wrapper 的 jar，Studio 会自动补）
3. 连真机或开模拟器 → Run

命令行构建（需本机已装 Gradle 8.7+）：

```
cd android
gradle wrapper          # 只跑一次，生成 gradlew
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

首次启动时 `Seed.ensure()` 会灌一份示例数据：286 张照片、8 段视频、6 位家人、
本次批次的 18 个故事草稿（含 3 个已确认的），以及 4 条往年已发布的故事。

## 目录

```
android/
├─ settings.gradle.kts
├─ build.gradle.kts
├─ gradle.properties
└─ app/
   ├─ build.gradle.kts
   └─ src/main/
      ├─ AndroidManifest.xml
      ├─ java/family/ourkids/app/
      │  ├─ MainActivity.kt              壳：WebView + /api 拦截
      │  ├─ data/
      │  │  ├─ Entities.kt               四张表：people / media / stories / story_media
      │  │  ├─ Daos.kt                   查询与写入
      │  │  └─ AppDatabase.kt            建库 + Seed 示例数据
      │  └─ net/
      │     └─ ApiServer.kt              把数据库包成 /api/* 的本地接口
      ├─ res/values/{strings,colors,themes}.xml
      ├─ res/drawable/ic_launcher_foreground.xml
      ├─ res/mipmap-anydpi-v26/ic_launcher{,_round}.xml
      └─ assets/www/            ← 全部页面在这里
         ├─ home.html           首页（启动页）
         ├─ age.html            故事集列表
         ├─ story.html          故事内页
         ├─ search.html         搜索
         ├─ upload.html         上传与确认（读数据库）
         ├─ card.html           故事卡片
         ├─ index.html          演示总览
         └─ spec.html           设计说明
```

页面里的中文文件名已全部改为 ASCII（`home / age / story / search / upload / card`），
站内链接也已同步替换，直接放进 WebView 就能跑。

## 壳层做了这几件事

| 项 | 实现 |
|---|---|
| 加载方式 | `WebViewAssetLoader` 把 assets 映射到 `https://appassets.androidplatform.net/assets/`，等同 https 源，避免 `file://` 的各种限制 |
| 本地接口 | `shouldInterceptRequest` 把同域名下的 `/api/*` 交给 `ApiServer`，返回 `WebResourceResponse` 的 JSON；页面里直接 `fetch` 即可，不用 JS Bridge |
| 状态栏让位 | 关掉 `decorFitsSystemWindows`，用 `WindowInsets` 给根布局加 padding，页面里固定的 44px 顶栏不会被状态栏压住 |
| 状态栏图标 | 浅色模式，深色图标 |
| 返回键 | 有历史就 `goBack()`，到首页再按一次退出 |
| 长按图片 | 弹出「保存这张照片」，走 `DownloadManager` 存到相册的「我们的孩子」目录（Android 10+ 免权限） |
| 视频 | `mediaPlaybackRequiresUserGesture = true`，必须点一下才播，和网页里的规则一致 |
| 上传 | 接管 `onShowFileChooser`，`upload.html` 里的选择文件可直接唤起系统相册 |
| 站外链接 | 一律交给系统浏览器，壳内不做跳转 |
| 旋转 | `configChanges` 里接管，旋转不重载页面 |

## 数据层

### 四张表

| 表 | 主要字段 | 说明 |
|---|---|---|
| `people` | id, relation, name, appearCount, refPhoto | 人工只填关系和 3 张参考照；出镜次数由人脸聚类累积 |
| `media` | id, type, takenAt, durationSec, **timeSource**, qualityScore, sceneTags, uri | 时间来源要记清楚，`exif / file / manual`，缺失的才会被发现 |
| `stories` | id, title, candidates, startAt, endAt, type, ageFromMonth/ToMonth, cover, people, scenes, photoCount, videoCount, confidence, status, **batch**, aiNote, deck, body, pull | `candidates` 用竖线分隔三个标题候选；`batch = 1` 表示属于本次上传批次 |
| `story_media` | storyId, mediaId, orderNo, role | 联合主键；`role` 取 cover / lead / inline / archive，决定这张图在内页的哪一段 |

几个刻意的设计：

- **月龄不用估**：生日存在 `child` 里，媒体时间取 EXIF，两者相减就是精确月龄，不靠人脸猜年龄
- **AI 只出草稿**：`status` 默认 `draft`，`confidence` 分 high / mid / low；low 的会带着「需要你命名」的提示，不硬编一个废话标题
- **同一批要看全**：`batch = 1` 的故事无论确认与否都会回到列表，这样「全部 18 / 待确认 15 / 已确认 3」才对得上

### 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/bootstrap` | 摘要数字（照片/视频/家人/草稿数）+ 人物列表 |
| GET | `/api/drafts` | 本次批次的全部故事，含已确认的（前端据 `status` 渲染 done 态） |
| POST | `/api/drafts/{id}/accept` | 接受一条草稿 → `status = published` |
| POST | `/api/drafts/accept-all` | 接受本批次所有高置信度草稿，返回影响行数 |
| POST | `/api/drafts/{id}/rename?title=xxx` | 改名 |
| GET | `/api/stories` | 已发布的故事列表 |
| GET | `/api/stories/{id}` | 单条故事，带 `media` 数组（按 `orderNo` 排好） |
| GET | `/api/people` | 家人与出镜次数 |
| GET | `/api/today` | 「N 年前的今天」：取覆盖今天的故事，没有就取最近一条 |

两点实现细节：

- `shouldInterceptRequest` 拿不到请求体，所以改名用 **query 参数**，不用 POST body
- 所有查询都发生在 `shouldInterceptRequest` 的**后台线程**上，所以 `AppDatabase.get()` 里可以直接跑建库和 seed；如果要在主线程调用，得改成 suspend 或加 `allowMainThreadQueries`

### 页面怎么用

`upload.html` 里就三段代码，不需要额外框架：

```js
// 读
Promise.all([get('/bootstrap'), get('/drafts')])
  .then(([boot, list]) => { renderStats(boot.stats); render(list); })
  .catch(() => render(DEMO));          // 浏览器里直接打开时退回静态样例

// 写
fetch(API + '/drafts/' + id + '/accept', { method: 'POST' });
```

`API` 常量是 `https://appassets.androidplatform.net/api`。这个域名只在壳里存在：
App 里被 `MainActivity` 拦成真实数据，浏览器里请求失败，页面自动退到写死的 6 条样例，
所以同一个 HTML 既能当交付 demo 看，也能在 App 里跑真数据。

### 换成真实照片库

1. 权限：`AndroidManifest.xml` 里加 `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`（Android 13+）与 `READ_EXTERNAL_STORAGE`（12 及以下）
2. 扫描：用 `MediaStore` 查 `Images` / `Video` 两张表，拿 `_ID`、`DATE_TAKEN`、`DURATION`、`WIDTH`、`HEIGHT`，
   映射成 `MediaItem`（`uri` 填 `content://media/...`，显示时可以直接塞进 `<img src>`）
3. 时间：`DATE_TAKEN` 为空时退回 `MediaStore.MediaColumns.DATE_MODIFIED`，并把 `timeSource` 记成 `file`，
   这样「时间存疑」的照片在确认页能被单独捞出来（`doubtfulTimeCount()` 已经在数了）
4. 识别：人脸聚类与场景标签交给外部模型（云端或端上 ONNX），场景结果写回 `media.sceneTags`，
   人脸框如果要持久化就再加一张 `faces(mediaId, personId, box)` 表（设计文档里的五表结构）；
   聚类完成后再聚事件、写 `stories`，`status` 一律先给 `draft`
5. 删掉 `Seed.ensure` 的调用，把 `AppDatabase.version` 加 1

## 换内容

替换 `app/src/main/assets/www/` 下的文件即可，注意两点：

1. 文件名保持 ASCII，或同步改掉页面里的 `href`
2. 图片：现在是 `picsum.photos` 的在线占位图，换成真实照片时把 `src` 改成本地路径
   （例如把图放进 `assets/www/photos/`，写 `src="photos/2019-01.jpg"`），这样离线也能看

## 已知限制

- 占位图走网络，**首次打开需联网**；断网时网页会显示浅色占位块
- 视频是占位交互，没有真实文件；`media` 表里只有时长，没有可播的流
- 只接了「上传确认页」一页的读写；首页、故事集、内页仍是静态数据，接口已经有了（`/api/stories`、`/api/today`），换 `fetch` 即可
- 没有写库的迁移，`version` 变更时用 `fallbackToDestructiveMigration()` 直接重建
- 草稿行的「合并」动作没做接口，目前只有接受与改名
- 未做签名与上架配置
