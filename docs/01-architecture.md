# 01 · 技术架构 / Technical Architecture

> 读者假设：写过前端、用过一个云平台、听说过 Kubernetes 但不需要它。**没写过 Terraform 也能读**，
> 每一步都会说清「这在解决什么问题」，而不是「这个配置项叫什么」。
>
> *Assumed reader: has shipped frontend, used a cloud platform, heard of Kubernetes but does not
> need it. No Terraform experience required — every section explains the problem being solved,
> not just the name of a setting.*

---

## 1. 全景：一次请求会经过谁 / The whole picture

```
                        ┌─────────────── ① 读 / read ───────────────┐
   iPad 浏览器 ─────────▶│ CloudFront  E2UWEFMOKOQEES                │
   Android App(WebView)─▶│  ├ ACM 证书(us-east-1) + 自定义域名        │
                        │  ├ OAC 签名回源（桶是私有的）              │
                        │  └ /apk/* → downloads 桶                   │
                        └──────┬────────────────────────┬───────────┘
                               │ 默认行为                │ /apk/*
                               ▼                        ▼
                    ┌────────────────────┐   ┌──────────────────────┐
                    │ S3  chenyouyi      │   │ S3 chenyouyi-downloads│
                    │  index.html        │   │  apk/album-N.apk      │
                    │  assets/js.<hash>/ │   │  apk/version.json     │
                    │  data/version.json │   └──────────────────────┘
                    │  data/manifest.*.json│
                    │  photos/<id>/…     │
                    └───────▲────────────┘
                            │ ④ 写 / write
        ┌───────────────────┴─────────────────────┐
        │ Lambda album-processor（容器镜像 3008MB）│◀── ③ S3 事件 incoming/
        │  sharp 三档 webp · ffmpeg 1080p/30s      │
        │  合并清单 · 失效 CDN · 删原图             │
        └───────────────────▲─────────────────────┘
                            │ ② 直传（预签名 PUT，8MB 分片）
                            │
   App ──① 登录/取地址──▶ API Gateway(HTTP API) ──▶ Lambda album-auth（512MB）
                                                      ├ DynamoDB 登录限流
                                                      └ SSM 三个参数
                            ┌──────────────────────┐
                            │ S3 chenyouyi-source  │  ← 原图只在这里停留几十秒
                            └──────────────────────┘
```

四条路径，四套完全不同的责任：

| 路径 / Path | 谁在服务 / Served by | 需要登录 / Auth | 状态在哪 / State |
| --- | --- | --- | --- |
| 浏览 | CloudFront + S3 | 否 | S3 对象（`data/manifest.*.json`） |
| 上传 | API Gateway + auth + 直传 S3 | 是 | DynamoDB（限流）+ S3（原图） |
| 处理 | Lambda processor（S3 事件驱动） | 隐式（桶通知） | S3（产物 + 清单） |
| 发布代码 | GitHub Actions | OIDC | 无 |

*Four paths with four different responsibilities — reading is public and static, writing needs a
token, processing is event-driven, and publishing code is authorized by OIDC.*

**这套系统里没有的东西，比有的东西更值得先记住**：没有常驻服务器、没有关系型数据库、没有
Kubernetes、没有前端框架、没有打包器、没有后端网关（Nginx）、没有 WAF、没有自建监控。
每一个「没有」都是刻意的，理由分散在后面各节。

*What is absent matters as much as what is present: no always-on server, no RDBMS, no
Kubernetes, no frontend framework, no bundler, no reverse proxy, no WAF, no self-hosted
monitoring. Every omission is deliberate.*

---

## 2. 前端：一个零依赖的静态应用 / The frontend

### 2.1 技术选择 / Tech choices

| 选择 / Choice | 具体 / What | 理由 / Why |
| --- | --- | --- |
| 原生 ESM，无框架 | `src/web/js/*.js`，11 个模块，`import` 相对路径 | 页面只有「列表 + 灯箱 + 三个模式」，引入框架的收益低于它带来的构建链与升级成本 |
| 无打包器 | 构建脚本只做「改名 + 注入占位符 + 复制」 | 模块数固定，HTTP/2 下并发拉 11 个文件不是问题；省掉一层 sourcemap 与缓存失效推理 |
| 零运行时依赖 | `package.json` 的 `dependencies` 只有 `sharp` + `exifr`（都只在构建/服务端用） | 前端没有任何第三方代码，也就没有前端供应链风险 |
| CSS 原生 | 一个 `style.css`，CSS 变量 + `clamp()` 字号阶梯 | 没有 Sass/PostCSS，改一行就是改一行 |

*Vanilla ESM with no framework and no bundler: eleven modules, no third-party runtime code, one
stylesheet. The build step only renames files and fills placeholders.*

### 2.2 产物长什么样 / What the build emits

```
dist/
├── index.html                 ← 模板占位符被替换；Cache-Control: no-cache
├── assets/
│   ├── js.446e251a/app.js     ← 目录名 = 全部 JS 的内容哈希；一年 immutable
│   ├── css.9f2c1b04/style.css
│   └── …
├── data/version.json          ← 指针文件；no-store
└── data/manifest.<rev>.json   ← 清单；文件名带哈希，可永久缓存
```

三个占位符在 `src/web/index.html` 里：`__TITLE__`、`__STYLE__`、`__APP__`，
外加 `__API_BASE__`（接口地址，来自构建时的 `ALBUM_API_BASE`）。

关键设计：**入口页永远不缓存，其余永远缓存**。`index.html` 是唯一「会被覆盖」的文件，
所以它 `no-cache`；`assets/js.<hash>/` 的名字里带内容哈希，内容一变名字就变，因此可以
`immutable` 缓存一年。这条规则让「发布」等于「换一个入口页」，而不是「等 CDN 过期」。

*The entry page is never cached; everything else is cached forever. `index.html` is the only
file that gets overwritten, so it carries `no-cache`, while hashed asset directories can be
immutable for a year. Publishing therefore equals replacing one file.*

### 2.3 运行时怎么拿到数据 / How data reaches the page

```
浏览器 → GET data/version.json        (no-store，约 200 字节)
       → { "rev": "376bf351fd93", "manifest": "data/manifest.376bf351fd93.json" }
       → GET data/manifest.<rev>.json (immutable，可被 CDN 缓存一年)
       → 渲染
```

为什么不让 `index.html` 直接内联清单：那样每加一张照片都要重新发布前端。
多一次往返换来「后端能独立更新内容」，这是 v4 里最有价值的一次交换。

*Two hops instead of an inlined manifest: one extra round trip buys independent content
updates — the most valuable trade in v4.*

前端还有一层热更新：页面常驻（照片墙）时轮询 `version.json`，`rev` 变了就重新拉清单。
所以「手机传完照片，墙上的 iPad 十分钟内自己换新」。

*The wall view polls `version.json`; when `rev` changes it refetches the manifest, so an
always-on iPad picks up uploads without a reload.*

### 2.4 用到的浏览器能力 / Browser capabilities in use

| 能力 / API | 用在哪 / Used for | 备注 |
| --- | --- | --- |
| Web Crypto `crypto.subtle.digest` | 上传前算 SHA-256，做对象名与去重 | 必须安全上下文（HTTPS/localhost） |
| `XMLHttpRequest` | 上传（需要上传进度） | **只有 XHR 能给上传进度**，`fetch` 至今没有；这是没用 fetch 的唯一原因 |
| `Blob.slice().arrayBuffer()` | 8MB 分片读进内存 | 见 §2.7 的坑 |
| `navigator.wakeLock` | 网页里的照片墙常亮 | App 内改用原生 `FLAG_KEEP_SCREEN_ON`，更可靠 |
| `IntersectionObserver` | 图片懒加载、区块渐显 | `prefers-reduced-motion` 下全关 |
| CSS `animation-timeline: view()` | 滚动驱动动画 | 不支持时自动降级为静态 |
| `hashchange` + `history.pushState` | URL 状态（可分享的视图/照片） | `#view/album/q/tag/year/month/p` |
| `localStorage` | 令牌、界面偏好 | 令牌只在 HTTPS 下写入 |
| `<picture>` + `srcset` | 320/768/2048 三档按视口取 | 与后端三档产物对应 |

*Notable: XHR is used for uploads purely because it is the only API with upload progress
events; hashing needs a secure context; the in-app keep-awake switches to a native flag.*

### 2.5 渲染模型：不裁切的编辑式栅格 / Layout without cropping

- 行高由每行图片的**原始宽高比**算出（justified rows），`object-fit: contain`，永远不裁切。
  这是硬约束（「照片不裁切、不加滤镜」）的直接实现。
- 目录按**年**连续排版，月份只做吸顶标签；按月切行会导致某些月只有一两张、右侧大片空白。
- `featured: true` 触发整行大图，但要求「距上一张 feature ≥ 3 张」，否则开头连续三张巨图。
- 行间距 `--gap` 由 JS 写入容器样式，**不能写在媒体查询里**——否则容器宽度比视口窄 80px，
  断点计算会错位。

*Row heights come from original aspect ratios with `object-fit: contain` — never cropping.
The catalog flows continuously by year; `featured` needs at least three photos of spacing;
the gutter is written by JS because a media-query value desynchronises the breakpoints.*

### 2.6 三个模式 / Three modes

| 模式 / Mode | 入口 / Entry | 说明 / Notes |
| --- | --- | --- |
| 浏览（时间轴 / 相册） | 默认 | 年→月分组；关键词 + 标签 + 年月本地过滤 |
| 故事 `#mode=story` | 导航「故事」 | 全屏逐张推进，节奏可调 |
| 照片墙 `#mode=wall` | 导航「照片墙」 | 时钟 + 22:00–07:00 自动调光 + 常亮 + 控制条 3 秒自动隐藏 |

三个模式共用同一份清单与同一套图片产物，没有额外的后端。

*Three modes share one manifest and one set of image derivatives; no extra backend.*

### 2.7 上传 UI 的契约 / The upload contract

上传入口**不是无条件出现的**：`index.html` 里有 `<meta name="album-api" content="__API_BASE__">`，
构建时由 `ALBUM_API_BASE` 注入；为空则前端判定「这套产物没有后端」，按钮保持 `hidden`。
这样同一个前端既能本地全量构建（无后端），也能线上部署（有后端）。

*The upload button only appears when the API base was injected at build time, so the same
frontend serves both a backend-less local build and the live deployment.*

**这里藏着一个跨层耦合，值得单独记下**：WebView 里 `allowFileAccess = false`、
`allowContentAccess = false`（安全考虑），导致 `xhr.send(File)` 拿不到 `content://` 背后的
文件描述符——请求立刻以 0 字节失败。修法是**根本不要把 `File` 交给网络栈**：先
`blob.slice().arrayBuffer()` 读进内存再发。安全设置是对的，上传实现迁就它。

*A cross-layer coupling worth remembering: `allowContentAccess = false` in the shell (a
security setting) means `xhr.send(File)` cannot resolve the `content://` descriptor and fails
at zero bytes. The fix is to never hand a `File` to the network stack — read the slice into
memory first. The security setting is right; the uploader adapts to it.*

---

## 3. Android：一个刻意做小的壳 / The Android shell

### 3.1 APK 里装了什么 / What is actually inside the APK

| 内容 / Item | 大小量级 | 作用 |
| --- | --- | --- |
| 一个 `MainActivity`（Kotlin） | 几十 KB | 建 WebView、装桥、处理返回键/选图/离线 |
| 一个 `AlbumBridge` | 同上 | 三个 `@JavascriptInterface` 方法 |
| `UpdateManager` | 同上 | 拉 `/apk/version.json`、下载、校验、拉起安装器 |
| `offline.html`（本地资产） | 几 KB | 加载失败时的兜底页，印错误码与 URL |
| 图标 / 主题 | 几 KB | —— |
| **前端代码** | **没有** | 页面全部从线上拉 |

包名 `top.chenyouyi.album`，minSdk 26 / targetSdk 35，签名密钥 RSA 4096、25 年。

*The APK contains one Activity, a three-method bridge, an update manager, an offline page and
an icon. No frontend assets at all — everything is loaded from the live site.*

### 3.2 桥只有三个方法 / Three bridge methods, on purpose

| 方法 / Method | 网页侧用途 | 为什么必须原生 |
| --- | --- | --- |
| `setKeepScreenOn(Boolean)` | 照片墙常亮 | Web 的 Wake Lock 依赖页面可见性与安全上下文，切后台/加桌面图标就失效 |
| `reloadSite()` | 离线页「重新加载」 | 站点地址只存在 `BuildConfig.SITE_URL` 一处（来自 `gradle.properties`），页面拿不到 |
| `appVersion()` | 排查「线上新页面 + 旧 APK」 | 版本号只有原生知道；顺手让前端能显示它 |

三个方法名在 `src/web/js/native.js` 里是硬编码字符串，改一边不改另一边会**静默失效**；
R8 靠 `proguard-rules.pro` 保住它们。仓库两侧各钉一半：共享常量在 JS，注解在 Kotlin，
两边都有断言。

*Method names are literal strings on the JS side and `@JavascriptInterface` on the Kotlin side;
renaming one side fails silently, so each repo asserts its own half.*

**桥是注入到所有页面里的**，所以 `MainActivity` 必须限制导航：站内 URL 留在 WebView，
外站 URL 交给系统浏览器。否则等于把这三个方法交给任意网站。

*The interface is injected into every document, so navigation is restricted to our own origin;
foreign URLs are handed to the system browser.*

### 3.3 WebView 的关键设置 / Key WebView settings

```kotlin
javaScriptEnabled = true            // 页面本身就是 JS 应用
domStorageEnabled = true            // localStorage 存令牌
mediaPlaybackRequiresUserGesture = false  // 视频自动播
mixedContentMode = NEVER_ALLOW      // 一律 https，杜绝混合内容
cacheMode = LOAD_DEFAULT            // 听 CDN 的缓存头
allowFileAccess = false             // 不读本地文件系统
allowContentAccess = false          // 不读 content:// —— 也是上传必须分片的原因
setSupportZoom(false)               // 双指缩放交给页面自己（灯箱要捏合放大）
userAgentString += " AlbumApp/<ver>"// 服务端/日志能区分壳与浏览器
```

*Every setting above is a deliberate trade; `allowContentAccess = false` is simultaneously a
security win and the reason uploads must be sliced.*

### 3.4 四个「壳该做的事」 / Four things only the shell can do

| 需求 | 实现 | 说明 |
| --- | --- | --- |
| 全屏沉浸 | `WindowCompat.setDecorFitsSystemWindows(false)` + 透明状态栏 | 页面用 `viewport-fit=cover` + `env(safe-area-inset-*)` 让开刘海 |
| 返回键 | `OnBackPressedCallback` → `evaluateJavascript("window.__canGoBack()")` | 灯箱打开时先关灯箱，再退页面，最后才退 App |
| 选图 | `WebChromeClient.onShowFileChooser` + `PickMultipleVisualMedia` | 回调必须回填，否则页面永久等待 |
| 离线 | `onReceivedError`（仅主框架）+ `onReceivedHttpError`（仅 5xx） | 子资源失败不该整页变离线页；错误码与 URL 印在页面上 |

*Full-bleed layout, back-key interception, the file chooser bridge, and an offline page that
prints the real error code — the four things a WebView shell cannot delegate to the page.*

### 3.5 分发与应用内更新 / Distribution and in-app update

```
本机: ./gradlew assembleRelease  →  scripts/publish-apk.mjs
      → s3://chenyouyi-downloads/apk/album-<versionCode>.apk   (长缓存)
      → s3://chenyouyi-downloads/apk/version.json              (短缓存)
App : 页面加载完成 → GET /apk/version.json → 比 versionCode
      → 有新版 → DownloadManager 下载 → 校验 sha256 → FileProvider → 安装器
```

`versionCode` 与 `versionName` 只写在 `app/version.properties`，`build.gradle.kts` 读它，
发布脚本也读它——**一份来源，两处消费**。签名私钥 `album-release.keystore` 只在本机，
**不进任何仓库、不进任何流水线**，所以安卓没有 CI 构建。不上应用商店，私有发 APK。

*One version file read by both Gradle and the publish script. The signing key never leaves this
machine, which is exactly why the Android build has no CI.*

### 3.6 为什么不是 TWA / Why not Trusted Web Activity

TWA 要求站点通过 Digital Asset Links 验证，且依赖 Chrome 自定义标签；本机与用户的机型
（三星/荣耀/小米）表现不一致，而「常亮」这种能力在 TWA 里没有原生入口。一个 300 行的壳
换来确定的行为，比省下这 300 行划算。

*A TWA would need asset-link verification, depends on the installed Chrome, and exposes no
native hook for keep-awake. A 300-line shell buys deterministic behaviour.*

---

## 4. AWS：用了什么、各自负责什么 / AWS services in use

### 4.1 资源总表 / Resource inventory

| 服务 / Service | 名字 / Name | 职责 / Role | 关键配置 |
| --- | --- | --- | --- |
| S3 | `chenyouyi` | 站点产物（入口页、assets、清单、照片） | 私有 + PAB 四项全开 + SSE-S3；策略只允许 CloudFront |
| S3 | `chenyouyi-source` | 上传落地（`incoming/`） | 私有、**无版本控制**、30 天生命周期兜底、CORS(PUT, Expose ETag)、7 天清理未完成分片 |
| S3 | `chenyouyi-downloads` | APK 分发 | 私有，经 CDN `/apk/*` 暴露 |
| S3 | `chenyouyi-tfstate` | Terraform state | 版本控制 + SSE + PAB |
| CloudFront | `E2UWEFMOKOQEES` | CDN、TLS 终止、路径分流 | OAC、ACM、PriceClass_200、HTTP→HTTPS |
| ACM | `photos.chenyouyi.top` | 证书（us-east-1） | 由 `data` 引用，**不进 state**，不参与重建 |
| ECR | `album-processor` | 镜像仓库 | `IMMUTABLE`、扫描开启、只留 2 份 |
| Lambda | `album-auth` | 登录 + 签上传地址 + 合并分片 | 512MB / 10s |
| Lambda | `album-processor` | 转码、脱敏、写清单、删原图 | 3008MB / 900s / `/tmp` 4GB |
| API Gateway | `album-api`（HTTP API） | 4 条路由 + CORS + 限流 | 5 rps / burst 10 |
| DynamoDB | `album-auth-attempts` | 登录失败计数 | PAY_PER_REQUEST + TTL |
| SSM | `/album/auth/{phones,key_hash,jwt_secret}` | 三个配置/密钥 | SecureString |
| SQS | `album-processor-dlq` | 处理失败的落点 | 保留 14 天 |
| CloudWatch | 两个日志组 | 函数日志 | 保留 14 天 |
| IAM | 5 个角色 | 见 03 §3 | 最小权限，逐个写清 |

*Three data buckets plus a state bucket, one CDN, two Lambda functions sharing one image, one
HTTP API, one DynamoDB table, three SSM parameters, one DLQ, five IAM roles.*

### 4.2 为什么是三个桶不是一个 / Why three buckets

| 桶 / Bucket | 生命周期 / Lifecycle | 版本控制 / Versioning | 谁能写 |
| --- | --- | --- | --- |
| 站点桶 | 无（内容就是资产） | 关 | 发布流水线（仅 `assets/`+`index.html`）、processor |
| 源桶 | 30 天兜底 | **关** | auth 签出的预签名 URL、processor（删） |
| 下载桶 | 无 | 关 | 本机发布脚本 |

源桶关版本控制不是省事，是**隐私要求**：开了版本控制，`DeleteObject` 只写一个删除标记，
原图作为历史版本仍然躺在云上，「处理完就删」变成错觉。

*Versioning is off on the source bucket because of privacy, not convenience: with versioning
on, `DeleteObject` only writes a marker and the original survives as a non-current version.*

### 4.3 私有桶怎么被公开读 / How a private bucket is publicly readable

```
浏览器 ──TLS──▶ CloudFront ──SigV4 签名(OAC)──▶ S3 REST
                  │
                  └ 桶策略：Principal = cloudfront.amazonaws.com
                            Condition: AWS:SourceArn = 本分发的 ARN
```

三件事同时成立才读得到：① 请求来自这个分发（`SourceArn`）；② 由 OAC 用 SigV4 签过；
③ 桶策略允许。直连 S3 REST 端点没有这三样，一律 403——这一点是验收项。

*Three conditions must all hold: the request comes from that distribution, it is SigV4-signed
by OAC, and the bucket policy allows it. A direct S3 REST call has none of them.*

### 4.4 为什么是容器镜像，为什么一个镜像两个函数 / Container image, two entrypoints

| 决策 | 理由 |
| --- | --- |
| 不用 zip 包 | `sharp` 有原生二进制、`ffmpeg` 要系统包，zip 里放不下也装不上 |
| 不用官方 Lambda 基础镜像 | 它是 AL2023，仓库里没有 ffmpeg，得自己搬静态二进制 |
| 不用 `aws-lambda-ric` | 要原生编译（cmake + g++），分钟级且易碎；runtime API 本身只有「取任务→回结果」 |
| 一个镜像两个入口 | 依赖完全重叠；`image_config.command` 覆盖 `CMD` 即可切换，省一次构建、版本天然一致 |
| 只在 ubuntu runner 构建 | 本机 Apple Silicon 出的是 arm64，Lambda 起不来 |

*One image, two entrypoints selected by `image_config.command`. Built only on an amd64 runner
because a locally built arm64 image simply refuses to start on Lambda.*

### 4.5 API Gateway 的四件事与三件不干的事 / What the gateway does and does not do

干：**路由**（4 条 → 同一个函数，靠 `routeKey` 分发）、**CORS**（统一加头，否则浏览器
在本地就拦掉请求）、**限流**（5 rps / burst 10）、**协议转换**（HTTP ↔ Lambda event v2）。

不干：**不碰照片字节**（App 拿预签名地址直传 S3，否则 150MB 视频要过网关，多一份流量钱
和多一个超时点）、**不管静态文件**（那是 CloudFront）、**不做鉴权**（只透传
`Authorization`，校验在函数里）。

*Routes, CORS, throttling, protocol translation — and deliberately no photo bytes, no static
files, no auth decisions.*

### 4.6 用到的「特性」比「服务」更关键 / Features that carry the design

| 特性 / Feature | 用在哪 | 一句话 |
| --- | --- | --- |
| 预签名 URL | 直传 | 把一次 PUT 的权限签进 URL，客户端直连 S3，不经过后端 |
| S3 分段上传 | 大文件 | 8MB 一片，逐片预签名，服务端合并；单请求不再受体积与超时夹击 |
| S3 事件通知 | processor | `incoming/` 出现新对象即触发，天然解耦 |
| 条件写（`If-Match` / `If-None-Match`） | 清单 | 并发写指针冲突时返回 412，重读重合并，不会静默丢照片 |
| S3 桶策略 + PAB | 站点桶 | 私有桶只有 CDN 能读 |
| OAC | CloudFront→S3 | 用 SigV4 签名回源，替代已弃用的 OAI |
| CloudFront 失效 | 发布 | 只失效 `index.html` 与 `data/version.json` 两个路径 |
| 生命周期 | 源桶 | 30 天兜底 + 7 天清理未完成分片 |
| CORS | 源桶 | 允许站点源 PUT，并 `ExposeHeaders: ETag`（合并分片要用） |
| ECR `IMMUTABLE` | 镜像 | 同一个 tag 推第二次被拒，杜绝「tag 变了内容也变了」 |

*Presigned URLs, multipart upload, S3 events, conditional writes, bucket policy plus OAC,
targeted invalidation, lifecycle backstops, CORS with exposed ETag, immutable image tags.*

---

## 5. GitHub：用到了哪些能力 / GitHub capabilities in use

| 能力 / Feature | 用在哪 / Where | 作用 / What it buys |
| --- | --- | --- |
| Actions | 两个仓库共 3 条流水线 | 唯一 CI |
| OIDC（`id-token: write`） | 三条流水线 | 换 1 小时临时凭证，仓库里没有长期密钥 |
| Repository Variables | 桶名、分发 ID、角色 ARN、API 地址 | 明文标识符，泄漏不致命 |
| Repository Secrets | 手机号、密钥哈希、JWT 密钥 | 只给 infra 层用，日志里打码 |
| Environments（`production`） | `deploy-web` | 声明后会改变 `sub` 的格式（见 03 §2.4） |
| `paths` 过滤 | 两条构建流水线 | 改 CSS 不重建镜像，改 `src/server/**` 不发前端 |
| `concurrency` | 三条 | 发布不能并行（并发 sync 会互相删产物） |
| `matrix` | infra 四层 | 一条流水线跑四层 |
| 动态矩阵 `fromJSON` | infra 手动触发 | job 级 `if` 读不到 `matrix`，只能把矩阵本身算出来 |
| `GITHUB_STEP_SUMMARY` | 三条 | 把「推到哪、用了哪个 tag、碰了哪些前缀」贴到任务页 |
| `timeout-minutes` | build-image | 并发组不取消在跑的 job，卡住会把后面全堵死 |
| 三仓库可见性策略 | —— | `album` 公开、`album-infra` **私有**、`album-android` 公开 |

*Actions, OIDC, variables vs secrets, environments, path filters, concurrency, matrices
(including the dynamic kind), job summaries, timeouts, and a deliberate visibility split.*

为什么没有「分支保护 + required reviewers」：**required reviewers 只对公开仓库开放**，
私有仓库要 Enterprise。`album-infra` 必须私有，所以门槛换成「合并只 plan、apply 必须
手动 dispatch 并二次确认」。这个替代方案比审批门更硬：它挡住了整类操作，而不只是某个人。

*Required reviewers is public-repo-only below Enterprise. Since the infra repo must stay
private, the gate became "merging only plans; apply needs a manual dispatch plus a second
confirmation" — a harder gate, since it blocks a whole class of operation.*

---

## 6. Terraform：四层 + 单向依赖 / Infrastructure as code

| 层 / Layer | 管什么 / Owns | 依赖 |
| --- | --- | --- |
| `00-bootstrap` | state 桶、OIDC provider、3 个 GHA 角色 | 无（不能管理自己） |
| `10-storage` | 三个数据桶、桶策略、CORS、生命周期、通知 | bootstrap 的角色 |
| `20-edge` | OAC、CloudFront、缓存策略、`/apk/*` 行为、ACM 引用 | storage 的桶名 |
| `30-compute` | ECR、Lambda×2、API、DynamoDB、SQS、SSM、IAM | storage + edge |

三条纪律：

1. **数字前缀即依赖顺序**，`00 → 10 → 20 → 30` 严格单向，下游用
   `data.terraform_remote_state` 读上游输出，不共享 state。
2. **每层一份 state**（同一桶、不同 key），锁用 Terraform 1.10 的原生 S3 锁
   （`use_lockfile = true`），不再需要 DynamoDB 锁表。
3. **模块里不出现任何环境字面量**；桶名、域名、ARN 一律由调用方注入。

*Numeric prefixes encode the dependency order; layers talk through remote state, never shared
state; each layer has its own state file with native S3 locking; modules contain no
environment literals.*

**内容不进 Terraform**：照片和清单由处理函数写进桶，`terraform plan` 不该因为它们而变化。
`s3` 的 `PutObject` 永远不会出现在 state 里——这条边界一旦破了，每次传照片都会触发
「基础设施有差异」的错觉。

*Content never enters Terraform: photos and manifests are written by the processor, and a plan
ought never to change because someone uploaded a picture.*

---

## 7. 一页速查：技术栈与代价 / One-page cheat sheet

| 层 / Layer | 技术 / Tech | 换来的 / Gain | 付掉的 / Cost |
| --- | --- | --- | --- |
| 前端 | 原生 ESM、无框架 | 零依赖、改一行是一行 | 自己实现路由、状态、布局 |
| 壳 | Kotlin + WebView，3 个桥方法 | 网页改动即时生效 | 壳能力有限，重活要原生 |
| 接口 | API Gateway HTTP API | CORS/限流/路由托管 | 多一跳延迟（约 10~30ms） |
| 计算 | Lambda 容器镜像 | 无常驻、按次计费 | 冷启动、15 分钟上限 |
| 存储 | S3 ×3 + 清单对象 | 无数据库、天然幂等 | 没有事务、没有查询能力 |
| CDN | CloudFront + OAC | 私有桶也能公开读、全球边缘 | 失效不是瞬时的（秒级~分钟级） |
| IaC | Terraform 四层 | 可审阅、可回滚、可重建 | 学习曲线 + state 管理 |
| CI | GitHub Actions + OIDC | 无长期密钥 | 私有仓库没有审批门 |

*Each layer's trade-off in one line — the right column is what you pay for the left one.*
