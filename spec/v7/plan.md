# 我们的孩子 · 第七版实施方案 / Our Kids · Version 7 Plan

> Spec-Driven Development · 阶段 2 / 5（Plan） / Stage 2 / 5 (Plan)
> 状态：**已确认（v1.2，定稿）** / Status: **Confirmed, final**
> 日期 / Date: 2026-11-16
> 依据 / Baseline: [`spec/v7/spec.md`](./spec.md) v1.1（定稿，无未决项；O-01~O-06 与 A-3 全部采纳）
> **本文只描述「怎么做」，不重复需求**；实现中若发现要改需求，先回改 spec。
> *This plan describes the how only. Requirement changes go back to the spec first.*

---

## 0. 方案一句话

六个自包含 HTML 页面 + 三个文档页，构成浏览器端；同一批 HTML 复制进 `android/app/src/main/assets/www`（文件名转 ASCII），由单 `Activity` + `WebView` 承载，`WebViewAssetLoader` 提供 https 源，`shouldInterceptRequest` 把 `/api/*` 交给基于 Room 的本地接口——**页面零改动，只换数据源**。公开托管沿用 V6 的 S3 桶与 website 端点（只多一个只读前缀 `kids/`），写入由 App 持凭据完成，页面里不出现任何凭据。

*Six self-contained pages plus three doc pages form the browser build. The same files are copied into the Android assets with ASCII names, hosted by a single-Activity WebView; a local Room-backed API serves `/api/*`. Publishing reuses the V6 S3 bucket under a read-only `kids/` prefix; writes are performed by the app with a device credential that never appears in a page.*

---

## 1. 技术选型 / Stack

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 页面 | 原生 HTML + 内联 CSS/JS，**无框架、无构建器** | 六页规模小；自包含才能「双击打开」与「丢进 assets」两用（不变量 7） |
| 字体 | 系统字体栈（`Source Han Serif SC / Noto Serif SC / Songti SC / SimSun` 与 `PingFang SC / Microsoft YaHei`） | 不引 webfont：省字节、离线可用、避免 FOUT |
| 图片 | 占位 `picsum.photos`；真图放 `assets/www/photos/` 用相对路径 | 先用占位跑通版式；真图替换只改 `src` |
| 客户端 | AGP 8.5.2 / Gradle 8.7 / Kotlin 1.9.24 / KSP 1.9.24-1.0.20 / JDK 17 / compileSdk 34 / minSdk 26 | 与 V6 的 `album-android` 同代，避免再引一套工具链 |
| WebView | `androidx.webkit:webkit:1.11.0` → `WebViewAssetLoader` | assets 映射到 `https://appassets.androidplatform.net/assets/`，等同 https 源，避开 `file://` 的 CORS / fetch 限制 |
| 数据 | Room 2.6.1（runtime + ktx + KSP compiler） | 四张表 + 三条查询就够，不需要 ORM 之外的层 |
| 接口 | `WebResourceResponse` + 手写 JSON 序列化 | 字段少、形状稳定；引序列化库不划算，且要能逐字段进白名单 |
| 并发 | `kotlinx-coroutines-android 1.8.1` | 目前仅作依赖预留，实际查询全在 `shouldInterceptRequest` 的后台线程同步执行（见 §6.3） |

**明确不引入**：Vite / Webpack / React / Vue / Tailwind / TypeScript、Retrofit / OkHttp、Node 或 Java 服务端、CloudFront / CDN、PDF 生成库、图表库、动画库、任何 `https://` 运行时依赖（占位图与图床除外）。

---

## 2. 交付目录与体积基线 / Deliverables and size baseline

```
children-growth/
├─ demo-首页.html            27.7 KB   P1
├─ 故事集-1到3岁.html          12.5 KB   P2
├─ 故事内页-走路这件事.html      14.0 KB   P3
├─ 搜索-演示.html              13.8 KB   P4
├─ 上传确认页.html             18.6 KB   P5（读本地库；浏览器内退回样例）
├─ 故事卡片.html                9.4 KB   P6
├─ 演示总览.html                6.2 KB   入口页（文档）
├─ 设计说明.html               31.8 KB   交付文档（不计入预算）
├─ 套壳预览.html                9.1 KB   壳层示意（不计入预算）
├─ scripts/
│  ├─ check-pages.py          四条规定门禁（闭合 / 语法 / 体积 / 可公开）+ 自包含
│  ├─ sync-assets.py          交付版 → assets 的确定性同步（--check 进闸）
│  └─ assert-upload.cjs       上传确认页的 21 项 DOM 断言（jsdom）
├─ 历史版本/                    早期线框与 A/B 提示词
└─ android/
   ├─ settings.gradle.kts  build.gradle.kts  gradle.properties
   └─ app/
      ├─ build.gradle.kts
      └─ src/main/
         ├─ AndroidManifest.xml
         ├─ java/family/ourkids/app/
         │  ├─ MainActivity.kt          壳
         │  ├─ data/Entities.kt         四张表
         │  ├─ data/Daos.kt             查询与写入
         │  ├─ data/AppDatabase.kt      建库 + Seed
         │  └─ net/ApiServer.kt         /api/* 路由
         ├─ res/…                       strings/colors/themes/图标
         └─ assets/www/                 同一批 HTML（ASCII 文件名）
```

**体积基线（2026-11-16 实测，`ls -l` 字节数 / 1024）**

| 口径 | 实测 | 阈值（FR-14） | 余量 |
| --- | --- | --- | --- |
| 单页最大（`demo-首页.html`） | 27.7 KB | ≤40 KB | 12.3 KB |
| 六个产品页合计 | 96.0 KB | ≤120 KB | 24.0 KB |
| 文档页合计（不计入） | 47.1 KB | — | — |

### 2.1 原型在哪、怎么看

原型是**可点的**，不是图：整份交付物就在仓库里 [`children-growth/`](../../children-growth/)，入口 `children-growth/演示总览.html`，双击或本地起个静态服务即可（`python -m http.server 8080 -d children-growth`）。逐页对照见 spec §0.2。

**为什么 spec/plan 里没有截图**：本机 headless 浏览器渲染不出内容（R-02），截不到真图。因此文档里的「预览」是 `设计说明.html` 内的 **CSS 复刻缩略**（P1–P6 各一段，标注「预览缩略（非真机截图）」）。要真截图，需在有可用浏览器的机器上补一次，替换掉那六段缩略——这是待办 A-6。

---

## 3. 设计系统（实现侧） / Design system

变量在每页 `:root` 内重复声明（自包含的代价，见 §9 的一致性检查）。

| 类别 | Token | 值 | 约束 |
| --- | --- | --- | --- |
| 底色 | `--bg` | `#FFFFFF` | 主背景 |
| 交替底色 | `--bg-alt` | `#FAF8F4` | 整块换气用，不用于卡片 |
| 墨色 | `--ink` | `#111111` | 正文与标题同色，靠字号分层 |
| 次级 | `--mute` | `#767676` | 说明、时间、计数 |
| 分隔线 | `--rule` | `#E8E8E8` | 恒为 1px，不加重 |
| 强化分隔 | `--rule2` | `#DED8CD` | chip 描边、步骤线 |
| 暖赭 | `--accent` | `#B4795A` | 每页 ≤5 处（不变量 6） |
| 成功 / 警示 | `--ok` `--warn` | `#3B6D11` `#854F0B` | 仅取用/警告态 |
| 衬线 | `--serif` | 思源宋体 → Noto Serif SC → Songti SC → SimSun | 标题、正文（故事页）、卡片 |
| 无衬线 | `--sans` | Helvetica Neue → PingFang SC → 微软雅黑 | UI、说明 |
| 等宽 | `--mono` | ui-monospace → Consolas | 时间、计数、「01 / 08」 |

| 排版 | 值 |
| --- | --- |
| 根字号 | 16px（长辈模式 18px，全站 `rem` 等比） |
| 正文 | 17px / 1.85（故事正文 17px / **2.15**，`letter-spacing:.01em`） |
| 故事栏宽 | **620px**（正文与旁白同宽，居中） |
| 首屏图 | `object-fit: contain`，桌面 76vw × 72vh，移动 `100svh - 132px` |
| 圆角 / 投影 | **0 / 0**，全站无例外 |
| 图片滤镜 | `sepia(.1) saturate(.94)`，统一色温，不做二次调色 |
| 断点 | ≥1440 内容 1280 / 1024–1439 边距 56 / 768–1023 四栏→两栏 / <768 边距 20 单列 |
| 翻页 | 280ms 交叉淡入，一次只换一张 |

---

## 4. 页面实现要点 / Per-page implementation

### P1 `demo-首页.html`

- 首屏用**索引状态机**：`idx` 单变量 + `data-i` 标记，切换只改 `opacity` 与 `z-index`，不重建 DOM；`contain` 保证不裁切。
- 键盘 / 点击两侧 / 触摸滑动三套输入统一收在一个 `go(delta)`；到边界回环。
- 首屏提示只出现一次：`sessionStorage` 记 `hint-seen`，`prefers-reduced-motion` 时跳过。
- 年龄四栏是 `<a>`；document 级 click 里先 `preventDefault()` 打开灯箱，避免点图误跳转（V6.5 踩过的坑）。
- 大图 `onerror` 走内联 SVG data URI 占位，不出现破图图标。
- 「字」按钮切 `html.lg`（`font-size:18px`），不改任何局部 px。

### P2 `故事集-1到3岁.html`

- 筛选为纯前端：卡片带 `data-people` / `data-scenes` / `data-count` / `data-time`，筛选与排序都只 `classList.toggle('hide')`，不重排 DOM（保滚动位置）。
- 排序用 CSS `order`，避免读-写-重排。
- 卡片点击目标是整张卡（`data-href` + `role="link"` + `Tab` 可达）。

### P3 `故事内页-走路这件事.html`

- 段落顺序固定在 HTML 里写死（大图 → 双图 → 正文 → 旁白 → 竖图 → 视频 → 错位双图 → 正文 → 21:9 → 归档 → 上下篇），**不做按数据动态排版**——故事是手工排版物，不是模板产物。
- 进度条：`scroll` 事件里只写 `transform:scaleX()`，不写 `width`。
- 视频占位：静帧 + 9s 进度条 + 「演示」标记；点击才 `play()`，`mediaPlaybackRequiresUserGesture=true` 兜住 WebView 侧。
- 归档区用 `<details>` 折叠，零 JS。

### P4 `搜索-演示.html`

- 单输入框 `input` 事件 → 三个结果组各自过滤；命中词用 `split/join` 替换为 `<mark>`，**不引正则**（中文分词不到位的正则只会更糟）。
- 空态给 3 个替代 chip，点了直接改写查询。
- 明确不显示标签云（FR-08 最后一条）。

### P5 `上传确认页.html`

- 数据入口只有一处：`Promise.all([get('/bootstrap'), get('/drafts')])`；成功 `state.live = true`，失败 `render(DEMO)` 并在 `.src` 标注。
- 行模板 `rowHtml(s)` 是唯一渲染函数；`status === 'published'` 直接给 `.row.done`，因此「已确认」的行刷新后仍在列表里（FR-07 的最后一条）。
- 计数不信任后端：`countDone()` 数 DOM、`remainHigh()` 数 DOM 里未完成的高置信度行，避免二次请求带来的漂移。
- `accept` / `rename` 都是 `POST`；改名走 query 参数（`shouldInterceptRequest` 读不到 body）。
- 改名后**只给新 chip 绑监听**，不整行重绑（重绑会让「接受」被点两次）。
- 合并（V7.3）：只在 `aiNote` 提示「可能重复」的行出现第三个按钮，点了弹目标选择；成功后在源行盖一层「已并入 ×××」，不要立刻从 DOM 里删——突然消失比灰掉更让人不确定。

### P6 `故事卡片.html`

- 1080×1440 用 CSS 固定像素盒复刻，页面上按 `transform:scale()` 缩放预览，导出时按原尺寸取像素。
- 卡片里绝不出现 URL / 二维码 / 「长按识别」（FR-10）。
- 九宫格为同一卡片的 9 个实例，文案取不同故事。

### 文档页

- `设计说明.html`：左目录吸顶 + 五章；每页配 **CSS 复刻的缩略示意**并标注「预览缩略（非真机截图）」——本机 headless 浏览器不可用（见 §10 风险 R-02）。
- `演示总览.html`：6 张卡片入口。
- `套壳预览.html`：390×844 双机位静态示意 + 壳层行为表。

---

## 5. 数据契约 / Data contract

### 5.1 四张表（Room，`AppDatabase` version 1，`exportSchema=false`）

| 表 | 字段 | 说明 |
| --- | --- | --- |
| `people` | `id` PK, `relation`, `name`, `appearCount`, `refPhoto` | relation 为爸爸/妈妈/爷爷/奶奶/外公/外婆；**无**身份证、学校类字段（FR-13） |
| `media` | `id` PK, `type`(photo\|video), `takenAt`, `durationSec`, `timeSource`(exif\|file\|manual), `qualityScore`, `sceneTags`, `uri` | `timeSource != 'exif'` 即可数出「时间存疑」 |
| `stories` | `id` PK, `title`, `candidates`(竖线分隔 3 个), `startAt`, `endAt`, `type`(event\|series), `ageFromMonth`, `ageToMonth`, `cover`, `people`, `scenes`, `photoCount`, `videoCount`, `confidence`(high\|mid\|low), `status`(draft\|published\|merged), `batch`, `aiNote`, `deck`, `body`, `pull` | `batch=1` 标本次导入批次；`aiNote` 是 AI 自述（O-06 决定可见） |
| `story_media` | `storyId` + `mediaId` 复合 PK, `orderNo`, `role`(cover\|lead\|inline\|archive) | `orderNo` 决定内页顺序，`role` 决定出现在哪一段 |

**白名单**：接口只输出上表字段加派生字段（`range`、`age`）；不输出 uri 的本地绝对路径、不输出 EXIF 原文。

### 5.2 返回形状（单条故事）

```json
{
  "id": "st_walk", "title": "走路这件事",
  "candidates": ["走路这件事", "学会走路的那几个月", "2021 年的春天"],
  "range": "2021.03.14 — 2021.11.02", "type": "series",
  "age": { "fromMonth": 23, "toMonth": 31 },
  "cover": "https://…/300/380",
  "people": ["妈妈", "外婆"], "scenes": ["家里", "小区"],
  "photoCount": 23, "videoCount": 1,
  "confidence": "high", "status": "draft",
  "aiNote": "AI 建议标题 · 三个候选，选一个或自己改",
  "deck": "…", "body": "…", "pull": "…",
  "media": [{ "id": "md_001", "role": "lead", "order": 0, "type": "photo", "uri": "…", "durationSec": 0 }]
}
```

`media` 只在 `/api/stories/{id}` 里出现（列表页不背这个包袱）。

### 5.3 路由

| 方法 | 路径 | 返回 | 写 |
| --- | --- | --- | --- |
| GET | `/api/bootstrap` | `{child, stats{photos,videos,people,batchStories,pendingDrafts,highConfidence,stories,doubtfulTime}, people[]}` | — |
| GET | `/api/drafts` | `{total, highConfidence, items[]}`（批次全部，**含已确认**） | — |
| POST | `/api/drafts/{id}/accept` | `{ok, id}` | `status='published'` |
| POST | `/api/drafts/accept-all` | `{ok, accepted}` | 批量，返回影响行数 |
| POST | `/api/drafts/{id}/rename?title=` | `{ok, id, title}` | `title` |
| POST | `/api/drafts/{id}/merge?into=` | `{ok, id, into, moved}` | 见下（**V7.3 才实现**） |
| GET | `/api/stories` | `{total, items[]}`（published） | — |
| GET | `/api/stories/{id}` | 单条 + `media[]` | — |
| GET | `/api/people` · `/api/today` | 家人 / 今日回顾（无则 `{item:null}`） | — |

**幂等性**：`accept` 重复调用无副作用（`WHERE status='draft'` 不命中即 0 行）；`accept-all` 返回本次影响行数，前端据此改按钮文案。

**合并语义（A-3 已定，V7.3 实现）**：`POST /api/drafts/{id}/merge?into=<targetId>`

```
1. 目标必须存在且 status != 'merged'；源不能等于目标（自合并直接 400）
2. story_media：把源的每一行 orderNo 平移到目标末尾后改挂 storyId（不复制媒体行，媒体只有一份）
3. stories：目标 photoCount/videoCount 累加源的计数；源 status = 'merged'
4. 列表：batchAll() 排除 merged，所以源行消失；被合并的东西不会两边都算
5. 幂等：源已是 merged 时返回 200 + moved=0，不重复累加
```

`merged` 是**软删除**而不是物理删除：万一合错了，改回 `draft` 就能恢复，媒体与文案都还在。

### 5.4 发布与写验证（FR-13 的「写」）

`/api/*` 是**壳内接口**，只服务本机 WebView，不需要鉴权（Android 应用沙箱即边界）。需要验证的是**离开设备的那一步**——把本地库发布到 `kids/` 前缀。

```
App 内「完成并发布」
  → 1. 生成产物：6 页 HTML（复用 assets/www，不改）+ 展示尺寸图（剥 EXIF）+ manifest.json
  → 2. 取凭据：设备首次输入一次性口令 → 换取短期 token（存 App 私有 SharedPreferences，不进页面）
  → 3. 上传：按 manifest 逐对象 PUT 到 kids/（对象名带内容哈希，同 V6 FR-08 的命名法）
  → 4. 落索引：写 kids/manifest.<h8>.json，固定名 kids/manifest.json 指最新
  → 5. 失败：本地标记「未发布」，下次重试；旧版本继续在线（固定名回退）
```

三条硬约束（进 §9 门禁）：

1. **页面无凭据**：产物里 `token` / `secret` / `X-Amz-Signature` 出现即失败。
2. **写请求必带凭据**：上传端点对无凭据请求返回 401，且不落任何对象。
3. **只发展示尺寸**：原图与 `EXIF` 永不进产物（复用 V6 的重编码与强制断言）。

本期状态：**形状已定，未实现**。§9 的两条静态检查（无凭据 / 无绝对路径）现在就能跑；上传端点与凭据流程等 `kids/` 真正要上线时再落（V7.3）。

---

## 6. Android 壳与本地数据层 / Shell and local data

### 6.1 启动路径

`onCreate` → `setDecorFitsSystemWindows(false)` → 根 `FrameLayout`（WebView + ProgressBar）+ `WindowInsets` padding → `WebViewAssetLoader`（`/assets/` → `AssetsPathHandler`）→ `shouldInterceptRequest` 分流 → `loadUrl(START_URL)`。

### 6.2 请求分流

```
if (host == "appassets.androidplatform.net" && path.startsWith("/api/")) → ApiServer.handle(request)
else → loader.shouldInterceptRequest(url)
```

站外链接在 `shouldOverrideUrlLoading` 里交系统浏览器；同域一律 `false` 放行。

### 6.3 线程模型（关键约束）

`shouldInterceptRequest` 运行在 WebView 的**后台线程**，因此：

- `AppDatabase.get()` 内可以直接建库 + `Seed.ensure()`（同步查询合法）；
- 反过来，**若将来在主线程调用 `get()`，必须改成 suspend 或临时 `allowMainThreadQueries()`**，并在代码注释里写清楚。当前只有 `ApiServer` 一处调用，已加注释。

### 6.4 种子数据（`Seed.ensure`）

- 幂等：`if (storyDao.count() > 0) return`。
- 规模与页面数字对齐：286 张照片（`md_001..286`）、8 段视频（`vd_001..008`）、6 位家人、4 条往年已发布（`batch=0`）、批次 18 条（15 draft + 3 published）。
- 批次构成：6 条写全（有 deck / body / pull / aiNote）+ 12 条只填必要字段（`Tpl` 模板映射）。
- 15 张照片故意标 `timeSource='file'`，让「时间存疑」这个能力有数据可数。
- 首次插入约 294 行媒体 + 22 行故事，目标 <200ms（未实测，列 R-05）。

### 6.5 壳层行为

| 行为 | 实现 | 验收方式 |
| --- | --- | --- |
| 状态栏让位 | `WindowInsets` 给根布局 padding | 44px 顶栏不被压 |
| 返回 | `goBack()`，无历史则退出 | 连按两次退出 |
| 长按存图 | `hitTestResult` + `DownloadManager`；API 29+ 落 `Pictures/我们的孩子/` | 长按任意图出弹窗 |
| 上传 | `onShowFileChooser` 接管 | 确认页「选择文件」唤起相册 |
| 视频 | `mediaPlaybackRequiresUserGesture=true` | 进页面不自动播 |
| 旋转 | `configChanges` 接管 | 旋转不重载 |

---

## 7. 归档流水线（本期只交付形状） / Archive pipeline

本期交付的是**接口与字段形状**，不是算法本身（没有真实照片与模型凭证）：

| 步 | 本期状态 | 落地位置 |
| --- | --- | --- |
| EXIF 读时间 | 形状已定（`takenAt` / `timeSource`），算法未接 | `media` 表 + `Seed` 造数 |
| 生日 → 月龄 | 已定：`ageFromMonth` / `ageToMonth` 由外部算好写入 | `stories` 表 |
| 人脸聚类 | **不接**；`people` 表人工填 6 人 | 矛盾点：真接时需 `faces` 表，见 spec §3 非目标 |
| 场景标签 | 形状已定（`sceneTags` 逗号分隔） | `media.sceneTags` |
| 事件聚类 | 形状已定（`batch` + `startAt/endAt` + `candidates`） | `stories` |
| 文案生成 | 形状已定（`deck/body/pull` + `aiNote` + 3 候选） | `stories` |
| 置信度判定 | 已定三分与页面表现 | `confidence` + P5 渲染 |

**给 V8 的接口承诺**：不管算法怎么换，写进库的必须还是这四个字段的组合（`startAt/endAt`、`people`、`scenes`、`confidence`），页面不感知上游用的是模型还是人手。

---

## 8. 分期与依赖 / Slices

| 切片 | 交付物 | 依赖 |
| --- | --- | --- |
| V7.0 地基 | P5 + `stories` 两字段 + `/api/*` 8 条（merge 留到 V7.3）+ Room 四表 + Seed | 无 |
| V7.1 浏览 | P1、P2、P3、长辈模式、`/api/today` | V7.0 的 `stories` 形状定稿 |
| V7.2 出口 | P4、P6（卡片 + 九宫格） | V7.1 的标题与排版定稿 |
| V7.3 收口 | 四条门禁、`sync-assets --check`、`/merge` 与凭据流程、边界自查、年度册长图（O-02） | 全部页面冻结；两处写路径（合并、发布）一起做一次回归 |

---

## 9. 门禁与本地验证 / Gates and verification

四条硬门禁（`scripts/check-pages.py`，一次跑完）：

1. **标签闭合**：`html.parser` 逐页比对开闭栈，报告未闭合/多余标签及行号。
2. **内联 JS 语法**：抽出 `<script>` 内容拼成临时文件，`node --check`。
3. **体积**：单页 ≤40KB、六页合计 ≤120KB，超限失败并指出页名与超出量。
4. **可公开**：产物中不得出现 `X-Amz-Signature`、`Bearer <token>`、`secret=`、`file:///`、`C://Users//…`；命中即失败并报行号（FR-13 的静态兜底，负例已验）。

补充门禁：

- **一致性**：`python scripts/sync-assets.py --check` —— 按**字节**比对交付版与 `assets/www`，只允许文件名映射这一处差异。仓库内统一 LF（曾经混用过 CRLF，`--check` 会把这种差异当漂移报出来，是一次真实漂移事故换来的规则）。
- **行为**：`node scripts/assert-upload.cjs`（jsdom）—— 断言 P5 的 **21 项**：18 行渲染、三段计数、摘要四项、一键接受 9 个、单条接受、改名插 chip、三条接口调用、以及 fetch 失败回落 6 条且不白屏。jsdom 需装一次（`npm i -D jsdom`），脚本会依次找 `jsdom` 与 `C:/tmp/node_modules/jsdom`。**后缀是 `.cjs` 不是 `.js`**：仓库根 `package.json` 带 `"type": "module"`，`.js` 会被当 ESM，`require` 直接报错（第一次搬进仓库时踩到了）。
- **人工**：两端各开一遍六个页面；开长辈模式；灯箱与翻页；长按存图。

当前状态（2026-11-16）：`check-pages.py` 四条全绿（单页最大 27.7KB / 合计 96.0KB，负例注入 `Bearer` 能被抓到并指到行），`sync-assets --check` 一致，`assert-upload.cjs` 21/21 通过。

**为什么不靠截图**：本机 headless 浏览器渲染不出内容（R-02），所以文档里的「预览」是 CSS 复刻的缩略示意，并已标注「非真机截图」。行为验证改用 DOM 断言，比截图更硬。

---

## 10. 风险登记 / Risks

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R-01 | **本机无 JDK / Android SDK**，Kotlin 从未编译 | 工程可能编不过 | 只做结构自检（DAO 方法与调用一一对应、括号平衡、字段齐全）；交付时明确写「未编译」，首次同步在 Studio 里做 |
| R-02 | headless 浏览器不可用 | 无法出真截图 | 文档用 CSS 复刻示意 + 标注；行为用 jsdom 断言；真截图请你在本机补 |
| R-03 | 占位图依赖 `picsum.photos` | 断网时全是占位块 | 已知限制；真图换 `assets/www/photos/` 相对路径即离线可用 |
| R-04 | 交付版与 assets 版两份文件 | 改动漂移 | `sync-assets.py --check` 进门禁（§9） |
| R-05 | 首次 seed 294+22 行未实测耗时 | 首屏可能卡一下 | 目标 <200ms；超时就把 Seed 拆成「基础 6 人 + 首页 3 张」的懒加载 |
| R-06 | 顶栏 44/48、卡片底色差一阶（spec A-1/A-2） | 视觉不一致 | 已列为 O-03/O-04，V7.1 统一 |
| R-07 | `aiNote` 建议「合并」但页面还没这个动作（spec A-3 已定补 `/merge`） | 实现前那句话是空承诺 | 在 V7.3 落 `/merge`（语义见 §5.3）；落地前**先把该行 `aiNote` 的措辞改成「可能重复，稍后可合并」**，不指一个不存在的按钮 |
| R-08 | 视频为占位交互 | 演示时被当成 bug | 左上「演示」标记 + 已知限制写明 |
| R-09 | 公开托管已定（O-01） | 任何人拿到地址就能看图 | 只发展示尺寸（剥 EXIF）、不出原图与文件名；分享仍只发图片 |
| R-10 | 写验证只有「一次性口令换设备凭据」，未设计找回与吊销细节 | 口令泄露后无法快速止损 | 凭据短期 + 可作废；V7.3 补「作废并重发」一键操作 |
| R-11 | `kids/` 上传端点与凭据流程未实现 | 发布链路只在纸面 | §5.4 已定形状；实现前发布仍走手工 `aws s3 sync`（一次性、人工核对） |

---

## 11. 需求 → 实现追溯 / Traceability

| spec 条款 | 落地位置 |
| --- | --- |
| FR-01 首页 | `demo-首页.html` §4/P1 |
| FR-02 四层结构 | 六个页面的 `href` 关系 + `演示总览.html` |
| FR-03 故事集 | `故事集-1到3岁.html`（前端过滤 + `order` 排序） |
| FR-04 故事内页 | `故事内页-走路这件事.html`（固定段落 + 进度条 + 视频位） |
| FR-05 文案 | `stories.deck/body/pull/candidates/aiNote` + P3、P5 渲染；五条判据进 §8 验收 |
| FR-06 自动归档 | `Seed.batchStories()`（形状）+ `stories.batch/confidence` + §7 |
| FR-07 上传确认页 | `上传确认页.html` + `/api/drafts*` 四条路由（accept / accept-all / rename / merge；merge 为 V7.3） |
| FR-08 搜索 | `搜索-演示.html` |
| FR-09 今日回顾 | `demo-首页.html` 横带 + `/api/today` |
| FR-10 导出 | `故事卡片.html` |
| FR-11 两端 | `android/` 全量（§6）+ `sync-assets.py` |
| FR-12 长辈模式 | 各页 `html.lg{font-size:18px}` |
| FR-13 读公开写受控 | 无凭据页面的门禁（`check-pages.py` 第 4 条）+ §5.4 发布与验证 + 四表无识别性字段 |
| FR-14 预算 | `scripts/check-pages.py` 第 3 项 |

---

## 12. 下一步 / Next step

1. O-01 已定（公开托管 + 上传验证），spec 升 v1.0、本文升 v1.1；仍需你点头的是 O-02~O-06 与 A-3（`aiNote` 的「建议合并」怎么处理）；
2. 定完后按下表收口，再进 Implement：统一顶栏 44px 与卡片底色、按 A-3 的结论补 `/merge` 或改措辞、把 `check-pages.py` / `sync-assets.py --check` / `assert-upload.cjs` 三条门禁跑成绿（当前已绿，作为回归基线）；
3. 编 APK 需在你本机（或任意有 JDK 17 + SDK 34 的环境）执行 `gradle wrapper && ./gradlew assembleDebug`，编不过的地方把报错贴回来，我按 `plan` §6 改。

---

## 13. 修订记录 / Amendments

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-11-16 | 首版草案：目录与体积基线、设计 token、六页实现要点、四表与 `/api` 契约、壳层线程模型、三条门禁 |
| v1.1 | 2026-11-16 | 随 spec v1.0 更新：新增 §2.1「原型在哪、怎么看」（澄清无截图的原因与替代物）、新增 §5.4「发布与写验证」（`kids/` 前缀 + 设备凭据 + 三条硬约束）、门禁升为四条（可公开）、风险补 R-09~R-11 |
| **v1.2（定稿）** | 2026-11-16 | 随 spec v1.1 定稿：`stories.status` 补 `merged`；§5.3 新增 `/api/drafts/{id}/merge?into=` 与**合并语义五步**（软删除、幂等、不重复计数）；§4 补合并的交互要点；§8 的 V7.3 纳入 `/merge` 与年度册长图；R-07 改为「实现前先改措辞」的过渡办法 |
