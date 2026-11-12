# 个人相册 / Personal photo album

私人照片站：**<https://photos.chenyouyi.top/>**。
浏览是纯静态（S3 + CloudFront），上传是「手机 → 预签名直传 → 处理函数转码脱敏 → 写回站点桶」。
手机端是一个 WebView 壳 APK，私有分发，不上应用商店。

*A private photo site. Browsing is fully static; uploading goes phone → presigned direct PUT →
processor (transcode + strip metadata) → back into the site bucket. The phone client is a
WebView shell, distributed as a private APK.*

| 约束 / Constraint | 做法 / How |
| --- | --- |
| 照片不外泄元数据 | 构建与处理时重编码即剥离 EXIF；视频先取年月再清空容器与流元数据 |
| 照片不裁切、不加滤镜 | 布局按原始宽高比算行高，CSS 里没有任何 `filter` / `object-fit: cover` |
| 无服务器、无数据库 | 前端零依赖；后端只有一个镜像两个入口，状态存在 S3 对象里 |
| 成本 ≤ ¥15/月 | 实测约 **$0.003/月**（一年外推 ≈ $0.09/月） |
| 不上应用商店 | APK 私有分发，装一次，之后应用内更新 |

---

## 文档 / Docs

细节都在 [`docs/`](docs/README.md)，本文件只做入口。

| 文档 / Doc | 内容 / What |
| --- | --- |
| [`docs/01-architecture.md`](docs/01-architecture.md) | 用了什么：前端、安卓壳、AWS 服务、GitHub 能力、Terraform 四层 |
| [`docs/02-flows.md`](docs/02-flows.md) | 怎么连起来：读 / 传 / 发布 / 改基础设施，每条流的时序与失败分支 |
| [`docs/03-security.md`](docs/03-security.md) | 凭什么安全：威胁模型、七道边界、泄露演练、自检清单 |
| [`spec/v4/`](spec/v4/) | v4 的需求、方案与执行记录（过程记录，冻结） |
| [`spec/v1`~`v3`](spec/) | 历史迭代（冻结） |

*Everything detailed lives under `docs/`; this file is the entry point only.*

---

## 三个仓库 / Three repositories

| 仓库 / Repo | 管什么 / Owns | 发布方式 / Deploy |
| --- | --- | --- |
| [`album`](https://github.com/scott372199/album)（本仓库） | 前端、构建管线、两个 Lambda 的源码、断言 | 推 `main` → `deploy-web` 自动发前端；改 `src/server/**` → 自动推镜像 |
| [`album-infra`](https://github.com/scott372199/album-infra)（私有） | 四层 Terraform、三条流水线之一 | 推 `main` **只 plan**；`apply` 必须人工 dispatch 并二次确认 |
| [`album-android`](https://github.com/scott372199/album-android) | WebView 壳、签名、应用内更新 | **不在 CI 构建**：签名私钥只在本机，本机一条命令发布 |

共同原则：**仓库里没有任何长期密钥**。CI 用 OIDC 换 1 小时凭证，签名私钥只在本机。

*No long-lived credentials in any repository. CI exchanges an OIDC token for one-hour
credentials; the signing key never leaves this machine.*

---

## 结构 / Layout

```
src/
  build/     扫描、读 EXIF、三档图、视频转码、manifest
  web/       页面源码（index.html / style.css / js/，11 个 ESM 模块）
  server/    Lambda：auth/（登录与预签名）、processor/（处理与清单）、lib/、test/
docker/      处理镜像的 Dockerfile
docs/        系统说明（架构 / 联动 / 安全）
scripts/     样例、结构断言、仓库安检、密钥哈希
spec/        需求与设计文档（v1~v4）
photos/      源照片（gitignore；一处子目录 = 一个相册）
```

*Android client lives in `album-android`; this repo has no Kotlin.*

---

## 命令 / Commands

| 命令 / Command | 作用 / Purpose |
| --- | --- |
| `npm run build` | 扫描 `photos/` → 产出 `dist/`（本地全量） |
| `npm run build:web` | 只产出前端外壳，不读 `photos/`（CI 用这条） |
| `npm test` | 单测 64 项（服务端 + 前端纯函数） |
| `npm run verify` | 38 项结构断言（不连网、不碰 AWS） |
| `npm run check:repo` | 仓库安检：媒体 / 密钥 / 大文件 / 绝对路径（81 个文件） |
| `npm run hash-key` | 生成共享密钥与它的 scrypt 哈希 |
| `npm run samples` | 生成测试图片，验证管线是否通 |

基础设施在 `album-infra`：`make plan layer=XX`、`make apply layer=XX`、`make check`（58 项离线断言）。
**日常部署不在这台机器上跑**——推代码就发前端，改基础设施走 infra 仓库的手动 apply。

*Infrastructure commands live in `album-infra`. Day-to-day deploys do not run locally.*

---

## 三条不该忘的边界 / Three boundaries

1. **发布只发代码**：`deploy-web` 只写 `assets/` 与 `index.html`，**绝不对桶根 `sync`**——
   产物里没有 `photos/`，根级 `--delete` 会清空线上照片。
2. **内容只由处理函数写**：`photos/` 与 `data/` 归 `album-processor`，其他任何写者都不碰。
3. **仓库里没有密钥**：CI 走 OIDC，Secret 只存在 GitHub Secrets 与 SSM，签名私钥只在本机。

*Publish code only, content only via the processor, and no credentials in any repo.*

---

## 线上状态 / Deployment status

| 通道 / Channel | 地址 / Address |
| --- | --- |
| 正式 | **<https://photos.chenyouyi.top/>**（CloudFront + OAC + ACM，HTTP 301 → HTTPS） |
| 备用 | `https://d3mvmo06veyiuk.cloudfront.net/`（同一分发的默认域名） |
| 安装包 | `https://photos.chenyouyi.top/apk/album-<versionCode>.apk` |
| ~~旧 HTTP 端点~~ | ~~`http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`~~ 已下线（桶转私有） |

三个桶都是私有的：Public Access Block 四项全开，只有 CloudFront 的 OAC 能读，直连 S3 REST 一律 403。

---

## 把 iPad 当照片墙 / iPad as a photo wall

1. Safari 打开 `https://photos.chenyouyi.top/#mode=wall`。
2. 设置 → 显示与亮度 → 自动锁定 → **永不**，插上电源。
3. 防误触：设置 → 辅助功能 → 引导式访问，三击侧边键锁定。
4. **不要「添加到主屏幕」**：PWA 独立窗口下 iOS 的 Wake Lock 会失效，必须在普通标签页里跑。
5. 夜间 22:00–07:00 自动调暗、时钟转琥珀色；静止 3 秒控制条自动隐藏。

---

## 出问题了 / Troubleshooting

先看 [`docs/02-flows.md` 附录 A](docs/02-flows.md) 的排错表。三个最常见的：

| 现象 | 先查 |
| --- | --- |
| 线上还是旧页面 | `deploy-web` 是否真绿；`index.html` 是否 `no-cache`；失效有没有执行 |
| 照片传完不出现 | `album-processor-dlq` → CloudWatch 日志 → 源对象是否还在 |
| 大视频传不上去 | 走的是 8MB 分片吗；WebView 拿不到 `content://` 描述符时单请求必败（见 `spec/v4/tasks.md` §7） |
