# 个人相册（personal-photo-album）

一个纯静态的私人照片站点：本地一条命令，把 `photos/` 里的照片与短视频重新编码、剥离全部元数据，
生成时间轴 / 相册 / 故事模式 / 照片墙页面，再同步到 S3（经 CloudFront 对外）。

- **没有后端**：Node 只在本地构建时运行，产物是普通静态文件。
- **没有框架**：原生 HTML / CSS / ES Module，前端零运行时依赖。
- **隐私优先**：只发布重新编码后的展示图与短片；GPS、机型、序列号、原始文件名、精确拍摄时刻都不出本机。

当前版本 **v3**（2026-11-10 验收上线）：`https://photos.chenyouyi.top/`。迭代记录见 `spec/v3/`。

**v4 进行中**：增加安卓客户端、手机端按需上传（Lambda 处理）、Terraform 分层 IaC。
前端产物与照片内容解耦（`build:web` 只发代码，照片由处理函数写入），
处理函数见 `src/server/`，镜像构建见 `docker/` 与 `.github/workflows/build-image.yml`。
文档见 `spec/v4/`。

*Work in progress (v4): an Android client, on-demand uploads processed by Lambda, and
layered Terraform IaC. The frontend bundle is decoupled from content — `build:web`
ships code only, photos are written by the processor (`src/server/`, image build in
`docker/` and `.github/workflows/build-image.yml`). Docs live in `spec/v4/`.*

## v3 有什么

| 能力 | 说明 |
| --- | --- |
| 短视频 | `.mp4/.mov/.m4v` 转 1080p H.264，最长 30s；同目录同名 `图片+MOV` 自动配成 Live Photo |
| 编辑式栅格 | 大图与 2~3 张小图交替，按年连续排版，月份只作吸顶标签；照片一律不裁切 |
| 故事模式 | 按年分章，章节卡 → 逐张推进，可调速、可暂停，切走自动暂停 |
| 照片墙 | 全屏常驻轮播 + 时钟 + 夜间调光 + 屏幕常亮（需 HTTPS 或 localhost） |
| 热更新 | 常驻页面每 10 分钟问一次 `data/version.json`，有新版只换内容不刷新页面 |
| 直接链接 | `#p=<照片id>` 开灯箱、`#mode=story` 进故事、`#mode=wall` 进照片墙 |
| 三档图 | `thumb` 320w / `grid` 768w / `view` 2048w，另带 24px LQIP 先糊后清 |

## 目录

```
photos/            源照片与视频（gitignore，不入库）
  2026/            一级子目录 = 一个相册
  tags.csv         可选的标题 / 标签覆盖
  .albumignore     排除规则
src/
  build/           扫描、读 EXIF、图片三档、视频转码、manifest
  web/             页面源码（index.html / style.css / js/）
  server/            v4：Lambda 处理函数（auth / processor）与单测
  deploy/          AWS 部署脚本与配置模板
docker/             v4：处理镜像的 Dockerfile 与本地构建脚本
.github/workflows/  v4：镜像构建与前端发布
scripts/           样例生成、结构验证、仓库安检、密钥哈希
spec/              需求与设计文档（v1 / v2 / v3 / v4）
dist/              构建产物（gitignore）
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run samples` | 生成几张测试图片，验证管线是否通 |
| `npm run build` | 扫描 `photos/` → 产出 `dist/` |
| `npm run build:web` | v4：只发布前端代码，不读 `photos/`（照片由处理函数写入） |
| `npm run test:server` | v4：处理函数单测（纯函数，零依赖即可跑） |
| `npm run hash-key` | v4：生成共享密钥与它的 scrypt 哈希 |
| `npm run verify` | 结构断言（不连网、不碰 AWS） |
| `npm run check:repo` | 仓库安检：媒体 / 密钥 / 大文件 / 绝对路径 |
| `npm run hook:install` | 安装本地 pre-commit 钩子（可选） |
| `npm run deploy:preview` | 构建并同步到 S3 预览地址（不带 `--delete`） |
| `npm run deploy` | 构建 → 同步（含 `--delete`）→ 失效入口页 |

部署需要本机已配置 AWS CLI 凭证；脚本不会读取或写入任何密钥到仓库。

**处理镜像**在主路径上由 CI 构建：`.github/workflows/build-image.yml` 在 ubuntu runner 上
构建 `linux/amd64` 并推到 ECR（tag 为 git 短 sha）。本机是 Apple Silicon，直接 `docker build`
会产出 arm64 镜像，Lambda 起不来；确实需要本地推一版时用 `docker/build-push.sh <tag>`（已带
`--platform linux/amd64` 与镜像自检）。

*The handler image is built by CI on the main path: `.github/workflows/build-image.yml`
builds `linux/amd64` on an ubuntu runner and pushes to ECR, tagged with the short git SHA.
This machine is Apple Silicon, so a plain `docker build` yields an arm64 image that Lambda
refuses to start; for the rare local push use `docker/build-push.sh <tag>`, which already
pins `--platform linux/amd64` and runs a smoke test.*

## 为什么不把照片放进仓库

1. 照片是**最私密**的资产，一旦推上远端就无法收回（fork / 缓存 / 镜像）。
2. 仓库要能被干净克隆后独立构建，而源素材属于「数据」而不是「代码」。
3. `npm run check:repo` 会在提交前拦下任何图片、视频、>5MB 文件与疑似密钥。

## 隐私边界

- 构建时重编码即剥离 EXIF；视频转码前先取年月用于排序，再清除容器与流上的全部元数据。
- manifest 只包含展示所需字段（id / 相册 / 年月 / 比例 / 路径 / 可选标题标签）。
- 站点本身是公开的：私有桶与私有仓库都**不是访问控制**，真正的防线是构建时脱敏。

## 把 iPad 当照片墙

1. Safari 打开 `https://photos.chenyouyi.top/#mode=wall`（`#mode=wall` 直接进照片墙）。
2. 设置 → 显示与亮度 → 自动锁定 → **永不**（或 15 分钟）。插上电源。
3. 需要防误触时开「设置 → 辅助功能 → 引导式访问」，三击侧边键锁定在当前页面。
4. **不要「添加到主屏幕」**：PWA 独立窗口下 iOS 的 Wake Lock 会失效（WebKit 已知问题），
   必须在普通 Safari 标签页里跑。
5. 常亮需要安全上下文：`https://` 或 `localhost` 都行，`http://` 的 S3 预览不行。
6. 夜间 22:00–07:00 自动调暗、时钟转琥珀色；控制条里可随时手动切换。
7. 内容是热的：本地改完照片 `npm run deploy`，常驻页面每 10 分钟问一次版本，有新版就地换图不刷新。

屏幕上不动 3 秒控制条会自动隐藏，移动鼠标或轻点屏幕可唤回。

## 部署状态

| 通道 | 地址 | 说明 |
| --- | --- | --- |
| **正式** | **`https://photos.chenyouyi.top/`** | CloudFront + OAC + ACM，HTTP 自动跳 HTTPS |
| 备用 | `https://d3mvmo06veyiuk.cloudfront.net/` | 同一分发的默认域名 |
| ~~临时 HTTP~~ | ~~`http://chenyouyi.s3-website-ap-southeast-1.amazonaws.com`~~ | 已下线（桶转私有、网站托管已关） |

桶是私有的：Public Access Block 四项全开，只有 CloudFront 的 OAC 能读，直连 S3 一律 403。

发布流程：`npm run deploy` —— 先整目录 `sync --delete` 打一年长缓存，再单独覆盖
`index.html`（no-cache）与 `data/version.json`（no-store），最后失效这两个路径。
细节见 `spec/v3/plan.md` §10 与 `spec/v3/tasks.md` §6。
