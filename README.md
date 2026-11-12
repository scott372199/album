# 个人相册 / Personal photo album

私人照片站，线上地址 **<https://photos.chenyouyi.top/>**。纯静态前端 + 一个 Lambda 容器函数：
浏览只用 S3 + CloudFront，上传走「手机 → 预签名直传 → 处理函数转码脱敏 → 写回站点桶」。

*A private photo site at <https://photos.chenyouyi.top/>. Static frontend plus one Lambda
container: browsing is pure S3 + CloudFront, uploads go phone → presigned PUT → processor
(transcode + strip metadata) → back into the site bucket.*

| 约束 / Constraint | 做法 / How |
| --- | --- |
| 照片不外泄元数据 | 构建与处理时重编码即剥离 EXIF；视频转码前只取年月，之后清空容器与流元数据 |
| 照片不裁切、不加滤镜 | 布局按原始宽高比算行高，CSS 里没有任何 `filter` / `object-fit: cover` |
| 无服务器、无数据库 | 前端零依赖；后端只有一个镜像两个入口，状态存在 S3 对象里 |
| 成本 ≤ ¥15/月 | 见 `spec/v4/tasks.md` §6.1 的实测数字 |
| 不上应用商店 | APK 私有分发，装一次，之后应用内更新 |

## 1. 三个仓库 / Three repositories

| 仓库 / Repo | 管什么 / Owns | 谁触发发布 / Deploy trigger |
| --- | --- | --- |
| [`album`](https://github.com/scott372199/album)（本仓库） | 前端 HTML/CSS/JS、构建管线、Lambda 的 auth 与 processor 代码、单测与断言 | 推 `main` → GitHub Actions 自动发前端；镜像另推 ECR |
| [`album-infra`](https://github.com/scott372199/album-infra) | 四层 Terraform：bootstrap / storage / edge / compute | 推 `main` **只 plan**；`apply` 必须人工手动触发并二次确认 |
| [`album-android`](https://github.com/scott372199/album-android) | 安卓壳（WebView + 原生桥 + 应用内更新） | **不在 CI 构建**：签名私钥不进流水线，本机一条命令发布 |

三个仓库的共同原则：**仓库里没有任何长期密钥**。CI 用 OIDC 换短期凭证，签名私钥只在本机。
串起来的完整讲解见 [`docs/cicd-architecture.md`](docs/cicd-architecture.md)。

*No long-lived credentials in any repository. CI exchanges an OIDC token for short-lived
credentials; the signing key never leaves this machine. The full walkthrough is in
`docs/cicd-architecture.md`.*

## 2. 架构 / Architecture

```
                      ┌──────────────── 读 / read ────────────────┐
  iPad / 手机浏览器 ──▶ │ CloudFront (E2UWEFMOKOQEES, ACM, OAC)     │
                      └───────┬───────────────────────┬───────────┘
                              │ /  /photos/* /assets/*│ /apk/*
                              ▼                       ▼
                    ┌──────────────────┐    ┌────────────────────┐
                    │ S3 chenyouyi     │    │ S3 chenyouyi-      │
                    │  index.html      │    │    downloads       │
                    │  assets/ data/   │    │  apk/*.apk         │
                    │  photos/         │    │  apk/version.json  │
                    └────────▲─────────┘    └────────────────────┘
                             │ 写 / write（处理后）
        ┌────────────────────┴────────────────────┐
        │ Lambda album-processor（容器镜像）       │◀── S3 事件 incoming/
        │  sharp 三档 webp · ffmpeg 1080p · 清单合并│
        └────────────────────▲────────────────────┘
                             │ 预签名 PUT
   安卓 App ──▶ API Gateway ─┴─▶ Lambda album-auth（/auth /upload-url /health）
                                   │
                                   ├─ DynamoDB：登录限流（TTL）
                                   └─ SSM：手机号白名单、密钥哈希、JWT 密钥
```

一个镜像两个入口：`auth/handler.handler` 与 `processor/handler.handler`，靠
`image_config.command` 区分，共享同一份依赖与同一套构建。

*One image, two entrypoints — `auth` and `processor` — selected by `image_config.command`.*

### 2.1 两个函数各自干什么 / What each function does

| | `album-auth` | `album-processor` |
| --- | --- | --- |
| **谁叫它** | App 主动发 HTTP（经 API Gateway） | S3 事件：`incoming/` 下出现新对象 |
| **干什么** | 验手机号 + 共享密钥发 JWT；算好 key 与元数据后签发上传地址（小文件一个 PUT，大文件一组分片）；合并分片 | 下载原片 → sharp 出 320/768/2048 三档 webp、ffmpeg 转 1080p/30s → 写 `photos/<id>/` → 合并清单 → 删源对象 |
| **权限** | 只写 `incoming/*`，读不到照片目录；可读 SSM | 读源桶、写站点桶、发 CloudFront 失效 |
| **用户看得见吗** | 看不见（上传面板背后的接口） | 完全看不见 |
| **超时 / 内存** | 几秒 / 512 MB | 视频最长 15 分钟 / 3008 MB |

为什么不是一个大函数：触发方式根本不同（一个被人调、一个被事件调），超时与内存差两个数量级，
权限也该分开——签地址的那个不该有删照片的能力。共用同一个镜像只是为了少构建一次。

*Two functions, not one: different triggers (HTTP vs S3 event), two orders of magnitude
apart in timeout and memory, and the signing role must not be able to delete photos.*

### 2.2 API Gateway 在中间干什么 / What the API Gateway does

它只服务「App 要直接调用」的那四件事，一共干四件事：

1. **路由**：`POST /auth`、`POST /upload-url`、`POST /upload-complete`、`GET /health` 各指向
   `album-auth`（同一个函数，靠 `routeKey` 分发）。
2. **CORS**：给这些路由统一加 `Access-Control-Allow-Origin`——网页是跨域调用，缺了它浏览器
   直接把请求拦在本地，连 Lambda 都不会被叫醒。
3. **限流**：`throttle_rps` / `throttle_burst`，被刷时挡住而不是把账单刷上去。
4. **协议转换**：把 HTTP 请求包成 Lambda 的 event（payload v2），再把返回值变回 HTTP 响应。

**它不干什么**，这点比它干什么更重要：

- **不碰照片字节**。照片是 App 拿着预签名地址**直传 S3**，不经过 API Gateway——否则 150MB
  的视频要穿过网关，多花一份流量钱，还多一个超时点。
- **不管静态文件**。页面、JS、照片由 CloudFront 从站点桶取。
- **不做鉴权判断**。它只负责把 `Authorization` 头透传过去，真正的 token 校验在 `album-auth` 里。

*The gateway routes, applies CORS, throttles, and translates HTTP↔Lambda events. Photo
bytes never pass through it — the app PUTs straight to S3 with a presigned URL.*

### 2.3 为什么改网页不用重装 App / Why a web change needs no reinstall

App 是一个**壳**：一个 `WebView` + 一个站点地址 + 一张离线页。它做的事就是
`loadUrl("https://photos.chenyouyi.top/")`——页面、JS、CSS、照片全部从 CloudFront 拉。

所以：

| 改了什么 | 怎么生效 |
| --- | --- |
| 前端（HTML/CSS/JS/样式） | 推 `main` → `deploy-web` → **杀掉 App 重开**即可，无需重装 |
| 后端（两个函数、API 路由） | 换镜像 + `terraform apply` → 下次冷启动生效，App 完全不知道 |
| 安卓壳（桥方法、站点地址、离线页、权限、签名） | **必须重新装 APK** |

只有第三种要重装，因为只有它写死在 APK 里。三处跨仓库契约（原生桥的方法白名单、站点地址
只在 `gradle.properties`、离线页不自引外部资源）写在 `album-android/README.md`，两边各钉一半。

唯一的坑：**进程内的 WebView 不会自己换 bundle**，所以改完前端要杀掉 App 重开。
`index.html` 是 no-cache（每次都问），`assets/js.<hash>/` 是内容哈希 + 一年缓存（永不覆盖）。

*The app is a shell that loads the site; web and backend changes ship through the CDN and
Lambda, so only a shell change needs a new APK. Kill the app to pick up a new bundle —
an in-process WebView keeps the old one.*


## 3. 两条发布路径，一条上传链路 / Two release paths, one upload chain

| 路径 / Path | 触发 / Trigger | 只碰 / Touches | 绝不碰 / Never touches |
| --- | --- | --- | --- |
| 前端代码 | 推 `main`（`src/web/**` 等） | `assets/`（可 `--delete`）、`index.html` | `photos/`、`data/` |
| 照片内容 | 手机上传 → 处理函数 | `photos/<id>/`、`data/manifest.*.json`、`data/version.json` | `assets/`、`index.html` |

这条边界是整个 v4 最要紧的一条：`build:web` 的产物里没有 `photos/`，所以**任何对桶根的
`sync --delete` 都会清空线上照片**。流水线里有专门的守卫拦这件事，`npm run verify` 也钉着。

*This boundary is the crux of v4: the web bundle contains no `photos/`, so a root-level
`sync --delete` would wipe every photo online. A dedicated guard blocks it and `verify` pins it.*

## 4. 目录 / Layout

```
src/
  build/     扫描、读 EXIF、三档图、视频转码、manifest
  web/       页面源码（index.html / style.css / js/）
  server/    Lambda：auth/（登录与预签名）、processor/（处理与清单）、lib/、test/
docker/      处理镜像的 Dockerfile 与本地构建脚本
docs/        CI/CD 与 Ops 说明
scripts/     样例、结构断言、仓库安检、密钥哈希
spec/        需求与设计文档（v1~v4）
photos/      源照片（gitignore；一处子目录 = 一个相册）
dist/        构建产物（gitignore）
```

安卓客户端已迁出到 [`album-android`](https://github.com/scott372199/album-android)，
本仓库不再包含任何 Kotlin 代码。

## 5. 命令 / Commands

| 命令 / Command | 作用 / Purpose |
| --- | --- |
| `npm run samples` | 生成测试图片，验证管线是否通 |
| `npm run build` | 扫描 `photos/` → 产出 `dist/`（本地全量） |
| `npm run build:web` | 只产出前端外壳，不读 `photos/`（CI 用这条） |
| `npm test` | 单测：服务端 + 前端纯函数（64 项） |
| `npm run verify` | 38 项结构断言（不连网、不碰 AWS） |
| `npm run check:repo` | 仓库安检：媒体 / 密钥 / 大文件 / 绝对路径 |
| `npm run hash-key` | 生成共享密钥与它的 scrypt 哈希 |
| `npm run hook:install` | 安装本地 pre-commit 钩子（可选） |

需要 AWS CLI 的只有两处：`hash-key` 生成的结果要填进 SSM / GitHub Secrets，其余命令都不碰云。
**日常部署不在这台机器上跑**——推代码就发前端，改基础设施走 infra 仓库的手动 apply。

*Only `hash-key` touches AWS indirectly (its output goes into SSM and GitHub Secrets). Day-to-day
deploys do not run on this machine: push code to ship the frontend, manually apply Terraform for
infrastructure.*

## 6. 隐私边界 / Privacy boundary

- 展示图只保留「id / 相册 / 年月 / 比例 / 路径 / 可选标题标签」；GPS、机型、序列号、原始文件名、
  精确拍摄时刻都不进 manifest。
- 视频转码前先用 `ffprobe` 取 `creation_time` 算年月，再 `-map_metadata -1` 清空；顺序反过来年月也没了。
- 站点是公开的：私有桶与私有仓库都**不是**访问控制。真正的防线是构建与处理时的脱敏，以及
  「上传需要手机号 + 共享密钥」。
- 源桶 `chenyouyi-source` 里只有 `incoming/`，处理成功后原图立即删除（无历史版本）。

## 7. 部署状态 / Deployment status

| 通道 / Channel | 地址 / Address | 说明 |
| --- | --- | --- |
| 正式 | **<https://photos.chenyouyi.top/>** | CloudFront + OAC + ACM，HTTP 301 → HTTPS |
| 备用 | `https://d3mvmo06veyiuk.cloudfront.net/` | 同一分发的默认域名 |
| 安装包 | `https://photos.chenyouyi.top/apk/album-<versionCode>.apk` | 回源 downloads 桶 |
| ~~旧 HTTP 端点~~ | ~~`http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`~~ | 已下线（桶转私有） |

桶是私有的：Public Access Block 四项全开，只有 CloudFront 的 OAC 能读，直连 S3 REST 一律 403。

## 8. 把 iPad 当照片墙 / iPad as a photo wall

1. Safari 打开 `https://photos.chenyouyi.top/#mode=wall`。
2. 设置 → 显示与亮度 → 自动锁定 → **永不**，插上电源。
3. 防误触：设置 → 辅助功能 → 引导式访问，三击侧边键锁定。
4. **不要「添加到主屏幕」**：PWA 独立窗口下 iOS 的 Wake Lock 会失效，必须在普通标签页里跑。
5. 夜间 22:00–07:00 自动调暗、时钟转琥珀色，控制条里可手动切换；静止 3 秒控制条自动隐藏。

## 9. 安卓客户端 / Android app

壳在 [`album-android`](https://github.com/scott372199/album-android)：一个 Activity 装一个全屏
WebView，指向线上站点；前端资产**不**打进 APK。构建、签名、发布、ROM 放行路径都在那边 README。

*The shell lives in `album-android`: one full-bleed WebView, no bundled assets. Build, signing,
publishing and OEM sideload paths are documented there.*

## 10. 文档 / Docs

| 文档 | 内容 |
| --- | --- |
| [`docs/cicd-architecture.md`](docs/cicd-architecture.md) | **从零讲清** OIDC、IAM role、Terraform state、Secrets vs Variables、两条流水线怎么串起来 |
| [`spec/v4/spec.md`](spec/v4/spec.md) | v4 需求（FR/NFR）与验收项 |
| [`spec/v4/plan.md`](spec/v4/plan.md) | 架构决策与技术细节 |
| [`spec/v4/tasks.md`](spec/v4/tasks.md) | 任务、检查点、实施偏差、交付记录 |
| `spec/v1`~`v3` | 历史迭代，冻结不改 |

## 11. 常见故障 / Troubleshooting

| 现象 | 先看这里 |
| --- | --- |
| 线上还是旧页面 | `deploy-web` 是否真的成功；`index.html` 的 `cache-control` 是不是 `no-cache` |
| 照片上传后不出现 | 处理函数日志 → 失败进 DLQ（`album-processor-dlq`）；源对象是否已删 |
| 大视频传不上去 / 选多个只进来一个 | WebView 拿不到 `content://` 的文件描述符。现在走 8MB 分片、每片读进内存，**不再把 `File` 交给网络栈**（见 `spec/v4/tasks.md` §7） |
| `POST /upload-complete` 回 400 | `invalid_key`：key 不在 `incoming/` 前缀或形状不对；`invalid_etag`：没拿到响应头的 ETag（源桶 CORS 的 `ExposeHeaders` 必须含 `ETag`） |
| 传图 403 `headers not signed` | 预签名必须同时传 `signableHeaders` 与 `unhoistableHeaders`（见 `verify.mjs` 那条断言） |
| CI 里 `terraform init` 卡住 | 本地沙箱会拦 `.terraform.lock.hcl` 的 rename；用 `-plugin-dir` 并关沙箱 |
| 安卓 App 显示「网络不可用」 | 先用手机浏览器打开同一地址；离线页会印 WebView 的错误码 |
