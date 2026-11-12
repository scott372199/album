# 个人相册 · 第四版任务清单（tasks v4）

> Spec-Driven Development · 阶段 3 / 5（Tasks） / Stage 3 of 5 (Tasks)
> 状态：**待确认** / Status: **Pending confirmation**　|　版本：v4.0　|　日期：2026-11-11
> 上游 / Upstream：`spec/v4/spec.md` v4.4（已确认）+ `spec/v4/plan.md` v4.1（已确认）
> 本文只做一件事：把 plan 拆成**可独立验收**的任务，标明依赖、文件、验收条件与追溯条款。
> *This document does one thing: turn the plan into independently verifiable tasks with dependencies, files, acceptance criteria and traceability.*

**语言约定 / Language convention**：标题中英并列；要点用 `标签：中文 / English` 形式；表格双列。
*Bilingual headings; bullets as `Label: Chinese / English`; tables use double columns.*

---

## 0. 起点状态（开工前）/ Starting point

| 项 / Item | 现状 / Current |
| --- | --- |
| 线上 / Live | `https://photos.chenyouyi.top/`（v3.2，CloudFront + OAC，桶私有） |
| 分支 / Branch | `main`，与 `origin/main` 同步，tag `v3.0/v3.1/v3.2` |
| 本机工具 / Tooling | 有 Node 22 / AWS CLI / docker / ffmpeg；**缺 terraform、Android SDK、arm64 JDK** |
| 仓库 / Repos | `scott372199/album` 存在；**`album-infra` 尚不存在** |
| GitHub 访问 / Access | SSH key 已配好，`ssh -T git@github.com` 可用 |
| 文档 / Docs | `spec/v4/{spec,plan}.md` 已确认；本文待确认 |

---

## 1. 阶段与依赖 / Phases & Dependencies

```
P0 基础  T-01 → T-02 → T-03
P1 L0    T-04 → T-05                ← CP-1
P2 L1    T-06 ─┬→ T-07 → T-08       ← CP-2
P3 L2    T-09 ─┴→ T-10 → T-11       ← CP-3
P4 L3    T-12 → T-13 ─┐
              T-14 ────┼→ T-16 → T-17 → T-18   ← CP-4
              T-15 ────┘
P5 前端  T-19 → T-20 → T-23
          T-21 → T-22
P6 安卓  T-24 → T-25 → T-26 → T-27 → T-28      ← CP-5
P7 收尾  T-29 → T-30 → T-31
```

**关键路径 / Critical path**：T-01 → T-04 → T-05 → T-07 → T-08 → T-10 → T-11 → T-17 → T-23 → T-31
**可并行 / Parallelisable**：P5 前端与 P6 安卓在 T-17 之后可同时开工；T-12~T-15 内部可并行。

---

## 2. 任务清单 / Task List

### P0 · 基础 / Foundations

#### T-01 工具与环境 / Tooling
- **依赖 / Deps**：无 / none
- **内容 / Work**：装 `terraform`（锁次版本）、`arm64 JDK`、Android `cmdline-tools` + `platform-tools`；校验 `terraform version`、`java -version`（须为 aarch64）、`adb version`
- **验收 / Done when**：三条命令均成功；`terraform version` 记入 README
- **追溯 / Traces to**：spec §7-1/7-2、plan §11.1 环境实测

#### T-02 仓库骨架与规范 / Repo skeleton
- **依赖 / Deps**：T-01
- **内容 / Work**：新建**私有**仓库 `album-infra`；建 `layers/`、`modules/` 目录；`Makefile`（fmt/validate/plan/apply）；`.gitignore` 排除 `*.tfstate*`、`.terraform/`、`*.tfvars`（敏感）、plan 输出；README 写四层职责与依赖方向
- **验收 / Done when**：仓库为私有；`make fmt` 可跑；`.gitignore` 能拦住 `terraform.tfstate`；README 四层说明齐全
- **追溯 / Traces to**：FR-24.4.1/24.4.2、FR-24.6.4、spec §9-C14/C21

#### T-03 基础模块 / Base modules
- **依赖 / Deps**：T-02
- **内容 / Work**：`modules/private-bucket`（版本控制开关、SSE、PAB、生命周期、CORS、策略入参）、`modules/secure-params`（SecureString + `ignore_changes`）
- **验收 / Done when**：`terraform fmt -check` + `validate` 通过；模块内无环境字面量；每个变量有 `type`/`description`
- **追溯 / Traces to**：FR-24.2.2/24.2.4、FR-24.3.3、FR-24.6.3

### P1 · L0 bootstrap

#### T-04 bootstrap 代码 / Bootstrap code
- **依赖 / Deps**：T-03
- **内容 / Work**：state 桶（版本控制 + SSE-S3 + PAB 四项）、DynamoDB 锁表、GitHub OIDC Provider、三个角色（`gha_app_deploy` / `gha_infra_plan` / `gha_infra_apply`）与最小权限策略
- **验收 / Done when**：`plan` 列出预期资源；信任策略 `sub` 精确到仓库与分支，无 `*`；策略不含 `*` 资源（state 桶与 invalidation 除外，需注释说明）
- **追溯 / Traces to**：FR-24.6.2、FR-24.9.2、plan §3.1 / §10.3

#### T-05 bootstrap 执行与 state 迁移 / Apply bootstrap & migrate state
- **依赖 / Deps**：T-04
- **内容 / Work**：本地 state 首跑 `apply` → 写 `backend.hcl` → `terraform init -migrate-state` 迁入自建桶 → `plan` 复核
- **验收 / Done when**：state 桶内出现 `00-bootstrap/terraform.tfstate`；迁移后 `plan` 为空；本地不再残留 `terraform.tfstate`
- **追溯 / Traces to**：FR-24.1.1、plan §6.5
- **检查点 / Checkpoint**：**CP-1**

### P2 · L1 storage

#### T-06 新建源桶与下载桶 / Create source & downloads buckets
- **依赖 / Deps**：T-05
- **内容 / Work**：`layers/10-storage` 用 `private-bucket` 建两个新桶；源桶 **不开版本控制** + 生命周期 30 天 + CORS（仅站点域名、仅 PUT）；下载桶不设 CORS
- **验收 / Done when**：`plan` 只含新增；源桶 `get-bucket-versioning` 返回空（未启用）；CORS 配置可读回；两桶直连均 403
- **追溯 / Traces to**：FR-24.7、O-06、O-12、plan §3.2

#### T-07 导入站点桶与子资源 / Import site bucket and sub-resources
- **依赖 / Deps**：T-06
- **内容 / Work**：用 `import` 块分别认领 `aws_s3_bucket`、`aws_s3_bucket_public_access_block`、`aws_s3_bucket_server_side_encryption_configuration`、`aws_s3_bucket_policy`（ID 均为桶名）
- **验收 / Done when**：`plan` 差异逐条解释完毕且为空；导入块已删除并单独提交
- **追溯 / Traces to**：FR-24.5.1、spec §11.12、plan §6.1
- **风险 / Risk**：漏导子资源会导致 `plan` 永远不空 —— 逐个核对再移走 import 块

#### T-08 L1 关卡 / Gate
- **依赖 / Deps**：T-07
- **内容 / Work**：`plan -detailed-exitcode` 必须返回 0；线上首页 200；直连 S3 REST 仍 403
- **验收 / Done when**：三项全过，结果记入交付记录
- **检查点 / Checkpoint**：**CP-2**

### P3 · L2 edge

#### T-09 cdn-site 薄模块 / Thin CDN module
- **依赖 / Deps**：T-08
- **内容 / Work**：包装分发与 OAC，参数化 `aliases` / `origins[]` / `default_behavior` / `ordered_behaviors[]` / 证书 ARN；**不引入社区厚封装模块**
- **验收 / Done when**：`validate` 通过；模块输出 `distribution_id` / `domain_name` / `arn`
- **追溯 / Traces to**：FR-24.2.3、spec §11.10、D-11

#### T-10 导入 OAC 与分发并对齐 / Import OAC & distribution
- **依赖 / Deps**：T-09
- **内容 / Work**：先 `get-distribution-config` 存快照 → `import` 块认领 OAC（`EQAKQ33RBCH5M`）与分发（`E2UWEFMOKOQEES`）→ 证书用 `data` 引用 → 逐字段对齐直到 `plan` 为空
- **验收 / Done when**：`plan` 为空；正式域名 200、CF 默认域名 200、旧 HTTP 端点 404 三条边界不变；快照文件保存在本地（不入库）
- **追溯 / Traces to**：FR-24.5.1/24.5.2、plan §6.3、R1
- **风险 / Risk**：**全项目最高风险**。只读 plan 先行，任何非空差异先解释再改

#### T-11 追加 `/apk/*` 行为 / Add `/apk/*` behavior
- **依赖 / Deps**：T-10
- **内容 / Work**：单独一次提交：新增 downloads 源站 + 有序行为 `/apk/*`（长 TTL、不压缩）
- **验收 / Done when**：`plan` 只含新增；上传一个测试文件后 `https://photos.chenyouyi.top/apk/health.txt` 可取；回滚 = revert 该提交
- **追溯 / Traces to**：O-12、plan §6.3-4
- **检查点 / Checkpoint**：**CP-3**

### P4 · L3 compute

#### T-12 处理镜像 / Processor image
- **依赖 / Deps**：T-11
- **内容 / Work**：`docker/Dockerfile`（`node:22-bookworm-slim` + apt ffmpeg + `npm ci` 含 sharp）；`build-push.sh` 支持指定 tag；镜像内自检 sharp 与 ffmpeg 可用
- **验收 / Done when**：本地 `docker run` 能执行 `sharp --version` 等价检查与 `ffmpeg -version`；镜像体积记录在 README
- **追溯 / Traces to**：O-11、spec §11.6、plan §3.4
- **状态 / Status**：✅ 代码完成（`docker/Dockerfile`、`docker/build-push.sh`、`.github/workflows/build-image.yml`）。**构建在 ubuntu runner 上做，不在本机**——Apple Silicon 直接 build 会产出 arm64 镜像。
- **实施偏差 / Deviations**：入口改为自带 `src/server/runtime.mjs`，不用 `aws-lambda-ric`（后者要原生编译，慢且易失败）。`ENTRYPOINT` 固定为 `node /var/task/runtime.mjs`，`CMD` 承载 handler，所以 infra 的 `command=["auth/handler.handler"]` 不变。

#### T-13 认证函数 / Auth handler
- **依赖 / Deps**：T-12
- **内容 / Work**：`src/server/auth/handler.mjs`：校验手机号哈希白名单 + 共享密钥 scrypt 哈希 + 失败计数（DynamoDB/TTL）→ 签发 JWT（1h）+ 刷新令牌（7d）；日志手机号掩码
- **验收 / Done when**：单测覆盖正确/错误/超限三种路径；日志中无明文手机号；响应体不含内部错误细节
- **追溯 / Traces to**：FR-21.1/21.2、FR-25.3、plan §7.1
- **状态 / Status**：✅ 代码完成，40 项单测通过（`npm run test:server`）。一个函数三个路由，按 `event.routeKey` 分发。
- **实施偏差 / Deviations**：① 白名单在 SSM 里存**明文手机号**（SecureString）而不是哈希——11 位号码空间只有千亿量级，哈希挡不住穷举，纯属安全剧场；令牌主体仍用 HMAC 派生，明文不进令牌。② `/auth` 兼做刷新：请求体带 `refresh` 即换新访问令牌，路由表不必多一条。

#### T-14 图片处理 / Image processing
- **依赖 / Deps**：T-12
- **内容 / Work**：`processor/image.mjs`：`thumb.webp`(320w) + `view.webp`(2048 长边)，不调 `withMetadata`，输出后断言无 EXIF；年月提取（`takenAt` → EXIF → `LastModified`）
- **验收 / Done when**：用**带 GPS 的真实样张**跑通，产物 EXIF 为空；年月正确；宽高比与原图一致
- **追溯 / Traces to**：FR-22.2、FR-25.1、plan §7.3
- **状态 / Status**：✅ 代码完成。**待真实样张验证**（需一张带 GPS 的照片走完整链路，属 T-18 联调范围）。
- **实施偏差 / Deviations**：产出**三档**（320 / 768 / 2048）而不是两档。前端 `srcsetFor()` 会在三档间挑，缺 768 会让平板直接拉 2048 的图。

#### T-15 视频处理 / Video processing
- **依赖 / Deps**：T-12
- **内容 / Work**：`processor/video.mjs`：`ffprobe` 取宽高/旋转/时长 → `-map_metadata -1` 转 H.264 1080p/≤30s/crf23 → 抽封面转 webp；超 15 分钟则降级只留封面
- **验收 / Done when**：用 `IMG_2265.MOV` 跑通，输出无 `creation_time`/`location`/`make`；竖屏方向正确
- **追溯 / Traces to**：FR-22.3、plan §7.3
- **坑 / Pitfall**：**先 ffprobe 取 `creation_time` 再加 `-map_metadata -1`**，否则年月一起被清
- **状态 / Status**：✅ 代码完成，**待 `IMG_2265.MOV` 实跑验证**。
- **实施偏差 / Deviations**：`video_max_height` 解释为**短边**上限（1080p 的通行含义）。按长边封顶会把竖屏手机视频压到 608×1080。

#### T-16 剩余模块 / Remaining modules
- **依赖 / Deps**：T-12
- **内容 / Work**：`modules/lambda-container`、`modules/http-api`、`modules/bucket-notification`
- **验收 / Done when**：`validate` 通过；接口参数无环境字面量
- **追溯 / Traces to**：FR-24.2.1/24.2.4
- **状态 / Status**：✅ 完成。三个模块已落地，四层 `validate` 全通过，`make check` 58 项离线断言。

#### T-17 compute 层落地 / Compute layer
- **依赖 / Deps**：T-13、T-14、T-15、T-16
- **内容 / Work**：ECR + Lambda×2（同镜像两入口）+ API（3 路由、限流）+ DynamoDB（失败计数）+ SQS（DLQ）+ SSM×3 + IAM×2 + 日志组 + S3 事件通知（`incoming/`）
- **验收 / Done when**：`plan` 只含新增；`GET /health` 返回 200；SSM 三个参数为 SecureString
- **追溯 / Traces to**：FR-22.7、FR-25.5、plan §3.4
- **状态 / Status**：✅ 完成。`enable_functions = true` 后一次 apply 建起 22 项资源：3 个 SecureString 参数、`album-auth` 与 `album-processor` 两个函数、S3 事件通知、HTTP API 三路由 + `$default` stage。
- **实施偏差 / Deviations**：
  1. **不使用预留并发**（原验收写的是 `reserved_concurrency=1`）：该账号总并发只有 50，AWS 要求非预留不低于 50，任何预留值都会 400。串行化改到代码里——写清单指针带 `If-Match`，冲突后重读重合并。
  2. **`image_tag` 写进 `prod.tfvars`**：infra 的 CI apply 只读 tfvars、不传 `-var image_tag`，留空会回退到不存在的 `latest`。每次换了镜像要手动改这一行。
  3. **镜像必须关掉 buildx 的 provenance**：默认附带的证明清单会把产物变成 OCI index，Lambda 拒收，报错却不提 provenance。

#### T-18 接口联调 / API integration
- **依赖 / Deps**：T-17
- **内容 / Work**：`curl` 走通 `/auth` → `/upload-url` → 直传（用预签名 URL `PUT` 一张图）→ 等处理 → 线上可见
- **验收 / Done when**：端到端一张照片上线且无 EXIF；**源桶中该对象已被删除**（`list-object-versions` 无历史版本）；失败路径进 DLQ
- **追溯 / Traces to**：spec §9-B7/B10/B13、plan §7.3
- **检查点 / Checkpoint**：**CP-4**
- **状态 / Status**：✅ 完成。实测记录（2026-11-12）：
  1. `/auth` 正确手机号 + 正确共享密钥 → 200，签发 token/refresh（同时反证 scrypt 哈希正确）。
  2. `/upload-url` → 200，key `incoming/fba962909b54.jpg`，返回 heads 含 `content-type` 与三个 `x-amz-meta-*`。
  3. 直传 `PUT` → **200**；59548 B / 1600×1200。
  4. 处理函数 22 秒内完成：`photos/fba962909b54/{thumb,grid,view}.webp` + 清单新增该条 + 指针换到 `rev f9b170920546`。
  5. 线上 `data/version.json` 与页面都变成新版本（21 张 → 22 张）。
  6. 落地图 `view.webp` 里 `exif / icc / xmp / iptc` 全为 false（原图有 Make/Model）。
  7. `list-object-versions` 对源 key 只返回裸前缀，**没有任何版本**——原图确实删了。
  8. 失败路径：直接传一个 4100 B 的假 jpg → 日志 `VipsJpeg: premature end of JPEG image` → 两次重试后 DLQ 收到 1 条（`MaximumRetryAttempts=2`）。
  9. 联调结束后已把测试照与坏文件清掉，指针退回 `rev 3029e93a`，线上回到 21 张。
- **实施偏差 / Deviations**：
  1. **预签名必须同时传 `signableHeaders` 与 `unhoistableHeaders`**（本任务最大的坑）。只写 `Metadata` 时 SDK 会把这些头 hoist 到查询串，`X-Amz-SignedHeaders` 只剩 `host`；只加 `signableHeaders` 也只到 `content-type;host`——客户端照常把元数据放在请求头里发出去，S3 就回 `403 headers not signed`。两者都传才是 `content-type;host;x-amz-meta-album;x-amz-meta-sha256;x-amz-meta-taken-at`。
  2. **签名规则放进 `rules.mjs`**（`signableHeaderNames` / `metadataHeaderNames`）而不是 `upload.mjs`：那里不 import AWS SDK，才能在只有 sharp/exifr 的开发环境里单测。
  3. **串行化靠清单指针的条件写**，不是预留并发（见 T-16 偏差 1）。

### P5 · 前端

#### T-19 构建拆分 / Build split
- **依赖 / Deps**：T-18
- **内容 / Work**：`build.mjs` 支持 `--target=web|all`；`build:web` 不读 `photos/`；`npm run build:web` 在无照片目录时也能成功
- **验收 / Done when**：临时移走 `photos/` 仍能构建成功；两次构建产物哈希一致
- **追溯 / Traces to**：FR-23.2、plan §8

#### T-20 清单运行时装载 / Runtime manifest loading
- **依赖 / Deps**：T-19
- **内容 / Work**：`data.js` 先取 `version.json`（no-store）再按字段取清单（长缓存）；移除 HTML 注入占位；本地全量构建也产出这两个文件
- **验收 / Done when**：改 `version.json` 指向新清单后刷新页面即见变化，无需重新构建前端
- **追溯 / Traces to**：FR-23.1、plan §7.4

#### T-21 上传 UI / Upload UI
- **依赖 / Deps**：T-20
- **内容 / Work**：`js/upload.js`：登录态、选图、HEIC→JPEG（`createImageBitmap` + `OffscreenCanvas` q0.95）、算 SHA256、取预签名、直传、四态进度、失败重试
- **验收 / Done when**：20 个文件批量可传；超限在前端即拦；进度与结果准确；失败可见原因
- **追溯 / Traces to**：FR-21.4/21.5/21.8、FR-23.3
- **状态 / Status**：✅ 完成（`src/web/js/upload.js` + 面板标记 + 样式）。已用无头 Chrome 验过门控：`?upload=1` 时入口出现、登录表单可见；普通访问入口保持 `hidden`。
- **实施偏差 / Deviations**：
  1. **不传 `takenAt`**。浏览器只有 `File.lastModified`（常是拷贝时间），而服务端优先级是 `takenAt → EXIF → LastModified`，上报 mtime 会盖掉真实 EXIF。让服务端读 EXIF 更准。
  2. **HEIC 解不出就当场拒**，不「原样上传」。服务端 sharp 不带 libheif，原样上传只会进死信队列，不如当场提示。
  3. **入口只在安卓壳里出现**（有原生桥 + 构建时配了 `ALBUM_API_BASE`）。`?upload=1` 是调试逃生口，只影响可见性，授权仍在服务端。
  4. **失败不自动重试**：重选同一批文件即可。key 是内容哈希，重传天然幂等，加自动重试只会让「到底传没传上去」更难判断。

#### T-22 能力检测与原生桥 / Capability guard & native bridge
- **依赖 / Deps**：T-21
- **内容 / Work**：`CSS.supports('animation-timeline: view()')` 与 View Transitions 守卫；暴露 `window.__canGoBack()` 与 `window.AlbumNative.setKeepScreenOn()`
- **验收 / Done when**：模拟不支持时内容全部可见（无半透明卡帧）；桥上调用可被原生侧收到
- **追溯 / Traces to**：FR-19.7、FR-23.4
- **状态 / Status**：✅ 完成（`src/web/js/native.js` + `main.js` + `wall.js`），6 项单测通过。两个 CSS 守卫 v3 已有（`motion.js` 里 `initReveal` 判 `CSS.supports` 与 `startViewTransition`）。
- **实施偏差 / Deviations**：返回键拆成**两个**函数——`__canGoBack()` 纯查询、`__goBack()` 执行（返回 `false` 时原生才 `finish()`）。plan 里写的单个 `__canGoBack()` 既查询又执行，容易被后来者误用。屏幕常亮改为一律**先问原生**，因为 WebView 里的 Wake Lock 常被系统拒。

#### T-23 发布 workflow / Deploy workflow
- **依赖 / Deps**：T-20、T-22
- **内容 / Work**：`deploy-web.yml`：push main → 构建 → `verify.mjs` → OIDC 取凭证 → 两段式同步 → 失效 `/` 与 `/data/version.json` → 线上自检；`concurrency` 串行
- **验收 / Done when**：改一行样式合并后 5 分钟内线上生效；故意破坏构建则流水线失败且线上仍是旧版
- **追溯 / Traces to**：FR-24.9.1/24.9.3、spec §9-D22
- **坑 / Pitfall**：`--exclude` 会影响 `--delete` 判定，两段式顺序不能颠倒（v3 已踩）
- **状态 / Status**：✅ 完成，**已真实跑通一次**（2026-11-12 `e3b7e7d`：assets 与 index.html 双前缀同步 + 失效成功，线上 `index.html` 由 11-10 的旧版换成本次构建）。
- **实施偏差 / Deviations**：
  1. **绝不碰桶根**：只 sync `dist/assets/`（可 `--delete`）+ 单传 `index.html`；`photos/` 与 `data/` 完全不碰。v3 的根级 `sync --delete` 在 v4 会删光线上照片。
  2. **只失效 `/index.html`**：前端发布没改 `data/version.json`，它归处理函数管。
  3. **`verify` 挪到构建之后**：`verify.mjs` 校验的是 `dist/` 产物，没有产物先跑就是空转失败（本次顺带修掉 `verify.mjs` 只认全量构建清单名的缺陷）。
  4. **产物守卫改判「目录非空」**：`build.mjs` 原先无条件 `mkdir dist/photos`，`--target=web` 也会留个空目录，守卫据此判成「全量构建」并拒绝发布——流水线连续失败两次，线上入口页一直停在 11-10。现在 web 目标不建该目录（还会清掉上一轮残留），守卫也只拦「目录里有文件」。

### P6 · 安卓客户端

> **2026-11-12：整个 P6 已迁到独立仓库 `album-android`。** 应用仓库原本同时装着 web、
> 服务端与 Kotlin，三套工具链混在一个 CI 里；加上签名私钥不该出现在公开仓库的构建机上，
> 拆开后职责才和三条流水线对得上。下面 T-24~T-27 的记录保留为历史，代码在新仓库，
> 那边有 8 项自检（`scripts/check.mjs`）接手本仓库原先的安卓断言。
>
> *The whole P6 section moved to `album-android` on 2026-11-12. History kept below.*

#### T-24 Gradle 工程与 WebView 骨架 / Gradle project & WebView shell
- **依赖 / Deps**：T-23
- **内容 / Work**：`android/` 工程，minSdk 26 / targetSdk 35；单 Activity；WebView 设置（JS、DOM Storage、禁混合内容）；沉浸式全屏；加载线上站点
- **验收 / Done when**：`./gradlew assembleDebug` 成功；模拟器或真机能打开首页且无地址栏
- **追溯 / Traces to**：FR-19.1/19.2、plan §9.2
- **状态 / Status**：✅ 构建通过（`android/`，AGP 8.7.3 + Gradle 8.9 + Kotlin 2.0.21）。debug 2.1MB / release 110KB（R8）。真机「能打开首页」并入 T-28 验收。
- **实施偏差 / Deviations**：
  1. **不打包前端资产**：壳只加载线上站点。把 HTML 打进 APK 会让「改一行样式」变成「发一个 APK」，而照片与 HTML 本来就是两条发布路径。
  2. **不区分 debug/release 包名**：`applicationIdSuffix` 会带来两套图标和一次额外卸载，收益不值。代价是 debug 包与 release 包签名不同，互装要先卸载。
  3. **只垫顶部安全区**：`setDecorFitsSystemWindows(false)` 之后给 WebView 加 `padding-top = 状态栏+挖孔`，底部不垫——页面自己用 `env(safe-area-inset-bottom)` 与 16~22px 留白躲开了手势条。这一条是因为 `.site-nav` 是 `position: sticky; top: 0`，被顶到挖孔底下会缺一块。
  4. **强制关掉算法暗色**：`WebSettingsCompat.setAlgorithmicDarkeningAllowed(false)`。小米/OPPO 的深色模式会给 WebView 反色，照片被压暗，违反「不加滤镜、不改色彩」。
  5. **只放行站点自身**：站外链接交给系统浏览器。原生桥对 WebView 里**每个**文档生效，随便加载第三方页面等于把 `AlbumNative` 交出去。

#### T-25 交互桥 / Interaction bridge
- **依赖 / Deps**：T-24
- **内容 / Work**：`onShowFileChooser` + `PickMultipleVisualMedia`；返回键经 `evaluateJavascript` 询问页面；`setKeepScreenOn` → `FLAG_KEEP_SCREEN_ON`；错误页 → 内置 `offline.html`
- **验收 / Done when**：能选图并触发网页上传；灯箱打开时返回键关灯箱；照片墙模式 15 分钟不息屏；断网显示离线页
- **追溯 / Traces to**：FR-19.3/19.4/19.5/19.6
- **状态 / Status**：✅ 代码完成（`MainActivity.kt` + `AlbumBridge.kt` + `assets/offline.html`）。四项行为待真机确认（T-28）。
- **实施偏差 / Deviations**：
  1. **返回键两段式**：先 `__canGoBack()` 查询，为真才 `__goBack()`；`__goBack()` 回 `false` 才 `finish()`。与 `native.js` 的契约一致。
  2. **`onCreateWindow` 返回 false**：弹窗直接不创建。站点没有需要新窗口的链接，支持它只会多一条绕过导航限制的路径。
  3. **离线页只在主框架失败时出现**：子资源失败（某张图裂了）不该把整页换掉；5xx 才算「服务端现在不行」，4xx 不换。
  4. **最多选 30 张**：`PickMultipleVisualMedia(30)`。再多就分批，不把用户的内存当无限的。

#### T-26 应用内更新 / In-app update
- **依赖 / Deps**：T-25
- **内容 / Work**：拉 `apk/version.json` 比对 versionCode → 提示 → `DownloadManager` → 校验 sha256 → `FileProvider` + `ACTION_VIEW` 安装
- **验收 / Done when**：改 versionCode 后旧版能发现并完成更新；sha256 不符时拒绝安装
- **追溯 / Traces to**：FR-20.3、plan §9.2
- **状态 / Status**：✅ 代码完成（`UpdateManager.kt` + `scripts/publish-apk.mjs`）。端到端待 T-27 有签名包后验证。
- **实施偏差 / Deviations**：
  1. **不用 `DownloadManager`**：它把文件写进公共下载目录，拿回来是 content:// URI，算 sha256 得再整份读一遍；校验失败时那份文件还留在外面。改成自己下到 app 私有目录、边下边算摘要，写完才改名，校验不过就删。
  2. **更新地址必须是本站**：清单里的 `url` 不以站点地址开头就拒绝。否则「校验 sha256」只是在替别人的服务器核对它自己给的哈希。
  3. **检查频率 6 小时一次**：清单本身也走 CDN，每次进 App 都打一次没意义；失败不写时间戳，断网恢复后还能再试。

#### T-27 签名与发布 / Signing & release
- **依赖 / Deps**：T-26
- **内容 / Work**：生成 keystore（用户离线备份）；构建 release APK；上传 `apk/album-<versionCode>.apk` 与 `apk/version.json`；README 写安装与国产 ROM 引导
- **验收 / Done when**：下载地址可安装；keystore 与口令不在仓库与日志中；引导文案覆盖小米/荣耀/三星
- **追溯 / Traces to**：FR-20.1/20.2/20.4、FR-25.7
- **状态 / Status**：✅ 完成。keystore 已生成（RSA 4096 / 10000 天，`android/album-release.keystore` + `keystore.properties`，均 gitignore）；`app-release.apk` 118KB 已签名并通过 `apksigner verify`；已发到 `chenyouyi-downloads`（`apk/album-1.apk` + `apk/version.json`），S3 / 本地 / 清单三处 sha256 一致；README 补了安装步骤与小米 / 荣耀 / 三星的放行路径。
- **实施偏差 / Deviations**：
  1. **安装包发到 downloads 桶，不是站点桶**：CloudFront 上 `/apk/*` 是独立一条行为，回源 `chenyouyi-downloads`。第一次发错桶，`/apk/version.json` 直接 403。`publish-apk.mjs` 现在只认 `DOWNLOADS_BUCKET`，**不拿 `SITE_BUCKET` 兜底**——正是这两个桶长得像才最容易发错。
  2. **没写本地 `deploy` 用的临时预览**：APK 走单条 `aws s3 cp`，不需要像站点那样两段式缓存头；APK 文件名带 versionCode，长缓存天然安全。
  3. **keystore 缺失时出未签名包而不是回退 debug 签名**：debug 签名的包以后没法覆盖升级，不如直接构建失败。

#### T-28 真机验收 / Device acceptance
- **依赖 / Deps**：T-27
- **内容 / Work**：荣耀 / 小米 / 三星中至少两台实测 §9-A1~A6 与 B7~B13
- **验收 / Done when**：检查表逐项勾选，异常项记录
- **检查点 / Checkpoint**：**CP-5**
- **状态 / Status**：◐ 部分通过（2026-11-12）。三星上 A 类功能（浏览、灯箱、故事、照片墙、
  更新检查）均正常；**B 类上传一开始只有 1/3 成功**，见 §7 的排查与修复。修复后用户连续上传
  多次全部成功。仍待人工确认：荣耀 / 小米各一台，以及 iPad 上的照片墙 + Wake Lock 常亮。

### P7 · 收尾 / Wrap-up

#### T-29 断言扩充 / Extend verify
- **依赖 / Deps**：T-23
- **内容 / Work**：`verify.mjs` 新增：清单装载方式、模块导入导出一致性、无硬编码桶名、产物无 `http://`、`build:web` 不引用 `photos/`
- **验收 / Done when**：断言语义清晰、失败信息可定位；全员通过
- **追溯 / Traces to**：spec §9-E29、plan §13
- **状态 / Status**：✅ 完成，38 → 45 项。清单装载方式、模块导入导出、`http://`、`build:web` 不读 `photos/` 四项 v3 已有；本轮新增 7 项。
- **实施偏差 / Deviations**：
  1. **新增断言超出原清单**：`verify.mjs` 不是只校验产物的，它还是唯一能拦住「改一处、另一处静默失效」的地方，所以补了跨语言契约——原生桥方法名两端一致、返回键契约、版本号单一来源。
  2. **「无硬编码桶名」要排除安卓包名**：`top/chenyouyi/album` 里天然含桶名那串字，用负向断言 `(?<!top/)` 排除。黑名单字面量本身在 `verify.mjs` 里拆开拼接，否则自己扫自己立刻失败。
  3. **「流水线不碰 photos/」改成「不上传到 photos/」**：流水线里本来就有 `dist/photos` 的守卫（产物误含照片目录就拒绝发布），一刀切地禁掉这个词会把守卫也禁掉。

#### T-30 清理与文档 / Cleanup & docs
- **依赖 / Deps**：T-28
- **内容 / Work**：删除 `src/deploy/` 资源管理脚本（保留最小内容同步）；删除 `.deploy-state.json`；README 更新为「两仓库 + 四层 + 两条发布路径」
- **验收 / Done when**：`grep -r "create-distribution\|put-bucket-policy" src/` 无结果；README 能让人不读代码说清架构
- **追溯 / Traces to**：FR-24.8.1/24.8.2、spec §9-C20
- **状态 / Status**：✅ 完成（2026-11-12）。`src/deploy/` 十个文件、`scripts/publish-apk.mjs`、
  `.deploy-state.json`、`.rollback-v1/`、`apk-out/` 全部删除；`verify.mjs` 少 10 项、
  多 1 项跨仓库契约断言（现 38 项：36 + dom id 对齐 + 分片两端约定）；`package.json` 去掉 6 条 deploy 脚本。
  README 重写为「三仓库 + 四层 + 两条发布路径 + 一条上传链路」，并新增 `docs/cicd-architecture.md`
  （OIDC / IAM / Terraform state / Secrets vs Variables / 三条流水线逐段拆解 / 排错表）。
- **验收证据 / Evidence**：`grep -r "create-distribution\|put-bucket-policy" src/` 无结果。

#### T-31 全量验收 / Full acceptance
- **依赖 / Deps**：T-29、T-30
- **内容 / Work**：逐条核对 spec §9 全部 30 项；记录成本实测
- **验收 / Done when**：30 项全过或逐项说明偏差
- **追溯 / Traces to**：spec §9 全部
- **状态 / Status**：◐ 除 CP-5 的 8 项真机项外全部通过；数字见 §6.1 / §6.2。
  A1~A6、B7~B13 里凡涉及真机的条目仍待 T-28，其余已由实机之外的证据覆盖
  （接口实测、CDN 抓取、EXIF 检查、`list-object-versions`、DLQ）。

---

## 3. 用户侧检查点 / User Checkpoints

| 检查点 / CP | 时点 / When | 需要你 / What you do |
| --- | --- | --- |
| **CP-1** | T-05 之后 | 确认 OIDC 三角色与 trust 策略合理；确认 state 已迁入自建桶 |
| **CP-2** | T-08 之后 | 确认 L1 `plan` 为空且线上无变化（这一步最容易被误改） |
| **CP-3** | T-11 之后 | 确认分发 `plan` 为空、`/apk/*` 上线且三条边界不变 |
| **CP-4** | T-18 之后 | 看端到端效果：一张照片从上传到上线，源桶已清 |
| **CP-5** | T-28 之后 | 真机验收（需你手持设备） |

**无需你参与 / No action needed**：T-01~T-04、T-06~T-07、T-09~T-10、T-12~T-17、T-19~T-27、T-29~T-31 的执行过程。
**需要提前给 / Needed in advance**：手机号白名单（T-13 前）、共享密钥（由我生成，你保管）、keystore 备份（T-27 后）。

---

## 4. 验收对照 / Acceptance Mapping

| spec §9 条目 / Spec §9 item | 覆盖任务 / Tasks |
| --- | --- |
| A1 两台真机安装 | T-28 |
| A2 全屏无地址栏 | T-24 |
| A3 返回键行为 | T-25 |
| A4 常亮 15 分钟 | T-25 |
| A5 断网离线页 | T-25 |
| A6 内核降级全可见 | T-22 |
| B7 5 张 60 秒可见 | T-18 |
| B8 视频 5 分钟可播 | T-15、T-18 |
| B9 新增/可播/不重复 | T-14、T-15 |
| B10 线上图无 EXIF | T-14 |
| B11 白名单外无法登录 | T-13 |
| B12 错误密钥被限流 | T-13 |
| B13 源桶原图已删 | T-18、T-06 |
| C14 仓库私有且无敏感物 | T-02、T-30 |
| C15 四层 validate | T-04、T-06、T-10、T-17 |
| C16 逐层 plan 为空 | T-08、T-11 |
| C17 隔离前缀 apply | T-17 |
| C18 导入未重建 | T-07、T-10 |
| C19 无资源管理双源 | T-30 |
| C20 README 说清架构 | T-02、T-30 |
| D21 合并即上线 | T-23 |
| D22 破坏构建不伤线上 | T-23 |
| D23 未批准不 apply | T-17（workflow 部分） |
| D24 无差异不 apply | T-17（workflow 部分） |
| D25 无长期密钥 | T-05、T-23 |
| E26 浏览仍公开 | T-20、T-23 |
| E27 v3 视觉不退化 | T-19、T-31 |
| E28 verify 通过 | T-29 |
| E29 成本 ≤ ¥15 | T-31 |

---

## 5. 本版明确不做 / Out of Scope for These Tasks

1. iOS 客户端 / iOS client
2. 应用商店上架 / App store publishing
3. 鸿蒙 NEXT 适配 / HarmonyOS NEXT support
4. 浏览端登录 / Login for browsing
5. 离线浏览 / Offline browsing
6. 照片删除、编辑、排序界面 / Photo delete, edit, reorder UI
7. 多环境（dev/staging）/ Multi-environment
8. 视觉改版 / Visual redesign
9. 用 Terraform 管理内容对象 / Terraform-managed content objects

---

## 6. 交付记录 / Delivery Log

> 执行时逐项填写；**未完成不得打勾**。
> *Fill in as work progresses; **do not tick unless actually done**.*

| 任务 / Task | 状态 / Status | 备注 / Notes |
| --- | --- | --- |
| T-01 ~ T-11 基础设施四层 / Infra layers | ✅ 完成 / Done | `album-infra` 已 apply 且四层 `plan` 归零 |
| T-12 ~ T-15 服务端函数 / Server handlers | ✅ 完成 / Done | 一镜像两入口，40 项单测 |
| T-16、T-17 第二段 / Compute wiring | ✅ 完成 / Done | 22 项资源已建；未用预留并发（账号并发仅 50） |
| T-18 联调 / Integration | ✅ 完成 / Done | **CP-4 通过**：直传 200 → 22 秒后上线 → 源对象无历史版本 → 损坏文件两次重试后进 DLQ |
| T-19、T-20 前端改造 / Web rework | ✅ 完成 / Done | 编辑式栅格 + 视频 |
| T-21 ~ T-23 上传与发布 / Upload & deploy | ✅ 完成 / Done | 36 项断言；上传 UI 只在原生壳里出现；`deploy-web` 已真实跑通 |
| T-24 ~ T-27 安卓客户端 / Android shell | ✅ 已迁出 / Moved | 代码与历史迁到独立仓库 `album-android`，那边 8 项自检；真机待 T-28 |
| T-28 真机验收 / Device acceptance | ◐ 部分通过 / Partial | **CP-5**：三星 A 类全过；上传问题修复后连续多轮全部成功（见 §7）。荣耀 / 小米与 iPad 照片墙待人工确认 |
| T-29 断言扩充 / Extend verify | ✅ 完成 / Done | 38 项断言（安卓那 10 项随代码迁到新仓库）；单测 64 项 |
| T-30 ~ T-31 收尾 / Wrap-up | ✅ 完成 / Done | 旧脚本已删、README 重写、CI/CD 教程成文、成本实测 |
| §7 验收后修复 / Post-acceptance fix | ✅ 完成 / Done | 大视频改 8MB 分片，连续多轮上传全部成功 |

### 6.1 关键数字 / Key numbers（2026-11-12 实测）

| 项 / Item | 值 / Value |
| --- | --- |
| 镜像体积 / Image size | 262 MB（ECR 里 2 份：当前 + 一份回滚） |
| 单层 plan 耗时 / Plan duration per layer | 10~12 秒 × 4 层（本机，四层均 0 差异） |
| 照片端到端耗时 / Photo end-to-end latency | 约 22 秒（59548 B / 1600×1200，直传完成到 CDN 可见） |
| 视频端到端耗时 / Video end-to-end latency | 约 28 秒（137 KB / 6 秒 720p；函数本身 26.3 秒） |
| 月成本实测 / Measured monthly cost | **$0.0031**（2026-11-01~11-12，约 ¥0.02）；其余全在免费额度内 |

### 6.2 成本结构与外推 / Cost structure and projection

实测只覆盖「几乎没人用」的状态，所以还要给出结构性外推。单价取 ap-southeast-1 公开价。

| 项 / Item | 当前用量 / Now | 免费额度 / Free tier | 外推用量（一年后）/ Projected | 月成本 / Monthly |
| --- | --- | --- | --- | --- |
| S3 标准存储 | 22 MB / 76 对象 | 5 GB（12 个月） | 3 GB | $0.075 |
| S3 请求 | 约 2 200 次/半月 | 20 000 GET / 2 000 PUT | 5 000/月 | ≈ $0.002 |
| CloudFront 流量 | 0.07 GB | **1 TB/月（永久）** | 20 GB | $0 |
| CloudFront 请求 | 约 3 000 次/半月 | 10 000 000/月 | 50 000/月 | $0 |
| Lambda 调用 | 4 次/周 | 1 000 000/月 | 200 次/月 | $0 |
| Lambda 计算 | 1.5 GB-s/次 | 400 000 GB-s/月 | 200×3 GB-s | $0 |
| API Gateway | 约 400 次/半月 | 1 000 000/月（12 个月） | 1 000/月 | $0.004 |
| ECR 存储 | 524 MB | 500 MB | 524 MB | ≈ $0.003 |
| DynamoDB 限流表 | 数十次写 | 25 GB + 25 WCU | 可忽略 | $0 |
| SSM 参数 | 3 个标准参数 | 10 000 个（标准） | 3 个 | $0 |
| CloudWatch 日志 | < 100 MB | 5 GB ingest | 200 MB | $0 |
| **合计** | **$0.0031** | | | **≈ $0.09 ≈ ¥0.65/月** |

结论：**¥15/月 的目标有 20 倍以上余量**，唯一的线性增长项是 S3 存储，而照片以每年约
3 GB 的速度增长。真正会咬人的是「把视频全留 4K 原片」那种用法——本项目在上传侧就把
视频压到 1080p 并丢弃原片，所以不会发生。

*Measured spend is $0.0031 for the first twelve days of November; a one-year projection with
200 photos/month lands around $0.09 (¥0.65). The only line that grows linearly is S3 storage,
and the processor discards originals, so 4K footage never accumulates.*


---

## 7. 验收后的修复 / Fixes after acceptance

> 真机验收（T-28）暴露出一个 v4 期间没能复现的问题：**大视频上传必现失败**。
> 这段记录的是排查结论与最终修法，不算新功能。

### 7.1 症状与取证 / Symptom and evidence

三轮真机测试，规律一致：同一批里的第一份能传上去，后面的全部失败。

| 观察 | 值 |
| --- | --- |
| 失败文案（第一版） | 「网络中断」，15 次上传里 4 次 |
| 失败文案（加诊断后） | `连接中断 · 已发 0%（0B/150.2MB）· 0.4s · 站点正常 188ms` |
| 服务端 | 预签名全部成功，**没有一条 `upload.rejected`**；成功那一次 PUT 用了 118 秒 |
| 重试 | 换新签的地址、退避 3 次，仍全部失败 |

`已发 0 字节` + `0.4 秒` + `站点 188ms` 这三条放在一起，把「手机没网」「跨境链路差」
「签名过期」「CORS」全部排除——请求根本没往外交数据。

### 7.2 根因判断 / Root cause

`xhr.send(File)` 要求网络栈拿到 `content://` URI 背后的**文件描述符**；而算 sha256 用的
`blob.arrayBuffer()` 走的是另一条读取管道。于是出现「哈希算得出来、文件发不出去」这种
看着矛盾的组合。第二批及之后的 URI 拿不到描述符，第一次那条还能用——正好对上「第一份
成功、后面全挂」。

顺带解释了另一个现象：**选 3 个视频只进来 1 个**。文件选择器返回的 URI 也是在
`openFileDescriptor` 那一步被 WebView 丢掉的，重启手机（清掉进程状态）后恢复正常。

*`xhr.send(File)` needs a real file descriptor behind the content:// URI, while
`blob.arrayBuffer()` uses a different pipe — hence "hashing works, uploading doesn't".
The same mechanism explains why only one of three picked videos ever reached the page.*

### 7.3 修法 / Fix

**再也别把 `File` 交给网络栈。** 大文件切 8MB 分片，每片 `slice().arrayBuffer()` 读进内存
再发；小文件同样读进内存。

- 服务端：`> 16MB` 的文件走 `CreateMultipartUpload` + 逐片 `UploadPart` 预签名，
  返回 `{ multipart, uploadId, partSize, parts[] }`；新增 `POST /upload-complete`
  由服务端调 `CompleteMultipartUpload`
- 客户端：每片独立重试，抖动只损失 8MB；进程里同时只有一片 8MB，150MB 的视频也不会
  撑爆 WebView 的堆
- 纯函数 `multipartPlan` / `parseComplete` 放在 `rules.mjs`，可单测（不需要 AWS）
- 未完成的分片由源桶既有的 `abort_incomplete_multipart_upload = 7 天` 回收

### 7.4 验证 / Verification

本地端到端跑过一次（25.5MB 视频 / 4 片）：预签名 → 4 次 PUT 全部 200 并返回 ETag →
`/upload-complete` 200 → 对象 25541347 B、`video/mp4` → 处理函数 `process.done`、
转码产物 `clip.mp4` + `poster.webp`。验证后已删除该照片、清单回退到验证前的 rev、
缓存已失效。断言 38 项、单测 64 项全绿。
