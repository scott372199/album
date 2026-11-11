# 个人相册 · 第四版技术方案（plan v4）

> Spec-Driven Development · 阶段 2 / 5（Plan） / Stage 2 of 5 (Plan)
> 状态：**待确认** / Status: **Pending confirmation**　|　版本：v4.1　|　日期：2026-11-11
> 上游：`spec/v4/spec.md` v4.4（已确认） / Upstream: `spec/v4/spec.md` v4.4 (confirmed)
> v4.1 变更 / Changes in v4.1：P02 定案——处理成功后删除源桶原图，源桶改为**不开版本控制** + 生命周期兜底。
> *P02 settled: delete the source original after successful processing; the source bucket drops versioning and gains a lifecycle backstop.*
> 本文描述**怎么做**：技术选型、资源清单、模块边界、接口契约、迁移顺序与回滚。
> *This document describes **how**: technology choices, resource inventory, module boundaries, API contracts, migration order and rollback.*

**文档语言约定** / **Language convention**：标题中英并列；正文先中文段落，紧跟一段斜体英文；表格用 `中文 / English` 双列。
*Headings are bilingual; each Chinese paragraph is followed by an italic English one; tables use `Chinese / English` columns.*

---

## 1. 总体架构 / Overall Architecture

### 1.1 一张图 / The picture

```
┌─────────────────┐        ①登录/取上传地址        ┌──────────────────┐
│ Android App     │ ─────────────────────────────▶ │ API Gateway      │
│ (WebView 壳)    │ ◀───── JWT + presigned URL ─── │ + Lambda(auth)   │
└────────┬────────┘                                └──────────────────┘
         │ ②直传原图 (PUT presigned)
         ▼
┌─────────────────┐   ③ObjectCreated   ┌──────────────────┐
│ 源桶 (私有)      │ ─────────────────▶ │ Lambda(processor)│
│ source          │                    │ sharp + ffmpeg   │
└─────────────────┘                    └────────┬─────────┘
                                                │ ④写产物 + 改清单
                                                ▼
┌─────────────────┐  ⑤回源(OAC)   ┌──────────────────┐
│ 站点桶 (私有)    │ ◀──────────── │ CloudFront       │ ◀── 浏览器 / App 浏览
│ 下载桶 (私有)    │ ◀──────────── │ photos.chenyouyi │
└─────────────────┘               └──────────────────┘
```

浏览链路保持不变：**公开、无需登录、纯静态**。新增的只有写入链路（①→④）。
*The read path is unchanged: public, no login, fully static. Only the write path (①→④) is new.*

### 1.2 组件清单 / Component inventory

| 组件 / Component | 技术 / Tech | 职责 / Responsibility |
| --- | --- | --- |
| 前端 / Frontend | 原生 ESM（沿用 v3） / Vanilla ESM (as in v3) | 浏览、灯箱、故事、照片墙；新增上传 UI |
| 安卓壳 / Android shell | Kotlin + WebView | 全屏加载站点、选图、常亮、应用内更新 |
| 认证函数 / Auth Lambda | Node 22 + JWT | 手机号+共享密钥 → 令牌；签发上传地址 |
| 处理函数 / Processor Lambda | Node 22 + sharp + ffmpeg（容器镜像） | 转码、脱敏、写产物、更新清单、失效 CDN |
| 接口 / API | API Gateway（HTTP API） | 三个路由，限流 |
| 存储 / Storage | S3 ×3 | 站点产物 / 原始上传 / APK 下载 |
| CDN | CloudFront + OAC | 回源、缓存、路径分流 |
| 参数 / Config | SSM Parameter Store（SecureString） | 手机号哈希表、共享密钥哈希、JWT 密钥 |
| 失败兜底 / Failure sink | SQS（DLQ） | 处理失败留痕 |
| 基础设施 / IaC | Terraform（分层 + 模块） | 全部资源的唯一真相源 |
| 触发器 / Trigger | GitHub Actions（OIDC） | 内容发布自动化、基础设施 plan/apply |

### 1.3 与 v3 的关键差异 / Key deltas vs v3

| 项 / Item | v3 | v4 |
| --- | --- | --- |
| 清单装载 / Manifest loading | 构建时注入 HTML / Injected at build time | 运行时经 `version.json` 解析 / Resolved at runtime |
| 构建 / Build | 单一命令，含照片 / Single, includes photos | `build:web`（零照片）/ `build:all`（全量） |
| 资源管理 / Resource mgmt | `src/deploy/*.mjs` 命令式 | Terraform 四层 + 模块 |
| 发布 / Publishing | 本机 `npm run deploy` | 合并 main 自动发布 |
| 新增照片 / Adding photos | 拷进 `photos/` 后重新构建 | 手机上传即发布 |
| 服务端 / Server | 无 / None | 3 个 Lambda + 1 个 API（无常驻） |

---

## 2. 仓库与目录 / Repositories & Layout

### 2.1 两个仓库 / Two repositories

| 仓库 / Repo | 可见性 / Visibility | 职责 / Responsibility |
| --- | --- | --- |
| `scott372199/album`（现有 / existing） | 公开 / Public | 前端源码、处理函数源码、构建脚本、安卓工程、断言 |
| `scott372199/album-infra`（**新建** / **new**） | **私有 / Private** | Terraform 全部代码、workflow、资源说明 |

> 为什么 infra 必须私有：内含 AWS 账号 ID、分发 ID、桶名。v3 就是因为这个把 `bucket-policy.json` 移出了版本控制。
> *Why private: it contains the AWS account ID, distribution ID and bucket names — the same reason v3 removed `bucket-policy.json` from version control.*

### 2.2 应用仓库新增目录 / New paths in the app repo

```
album/
├── src/
│   ├── web/               # 沿用，新增 upload 模块与能力检测
│   ├── build/
│   │   ├── build.mjs      # 改为 dispatcher：--target=web|all
│   │   └── ...
│   └── server/            # 新增：处理函数源码
│       ├── auth/handler.mjs
│       ├── processor/handler.mjs
│       ├── processor/image.mjs
│       ├── processor/video.mjs
│       ├── lib/{manifest,s3,log,token}.mjs
│       └── package.json
├── docker/
│   ├── Dockerfile         # node:22-slim + ffmpeg + sharp
│   └── build-push.sh
├── android/               # 新增：Gradle 工程
│   ├── app/src/main/java/top/chenyouyi/album/{MainActivity,AlbumBridge,UpdateManager}.kt
│   ├── app/src/main/AndroidManifest.xml
│   └── gradle/...
├── .github/workflows/deploy-web.yml
└── photos/                # 仍在，仅本地全量构建用
```

### 2.3 基础设施仓库结构 / Infra repo layout

```
album-infra/
├── README.md              # 四层职责、依赖方向、导入步骤、回滚
├── Makefile               # fmt / validate / plan / apply 便捷入口
├── layers/
│   ├── 00-bootstrap/      # state 桶、锁表、OIDC、三个角色
│   │   ├── main.tf  variables.tf  outputs.tf  backend.hcl  prod.tfvars
│   ├── 10-storage/        # 三个桶 + 策略 + 生命周期
│   ├── 20-edge/           # OAC + CloudFront + 缓存策略 + 路径行为
│   └── 30-compute/        # ECR + Lambda ×2 + API + DynamoDB + SQS + SSM + IAM
├── modules/
│   ├── private-bucket/
│   ├── cdn-site/
│   ├── lambda-container/
│   ├── http-api/
│   ├── secure-params/
│   └── bucket-notification/
└── .github/workflows/infra.yml
```

**为什么 layer 用数字前缀**：目录排序即依赖顺序，人一眼能看出谁先谁后。
*Why numeric prefixes: directory order equals dependency order, visible at a glance.*

---

## 3. IaC 分层与资源清单 / IaC Layers & Resource Inventory

### 3.1 L0 bootstrap

| 资源 / Resource | 说明 / Notes |
| --- | --- |
| `aws_s3_bucket` **tfstate** | 名 `chenyouyi-tfstate`；版本控制开；SSE-S3；PAB 四项全开 |
| `aws_s3_bucket_versioning` / `_server_side_encryption_configuration` / `_public_access_block` | 同上桶的附属配置 |
| `aws_dynamodb_table` **tflock** | 名 `chenyouyi-tflock`；PAY_PER_REQUEST；hash key `LockID` |
| `aws_iam_openid_connect_provider` | `token.actions.githubusercontent.com`，audience `sts.amazonaws.com` |
| `aws_iam_role` **gha_infra_plan** | 只读 + 可读 state；trust 限定 `repo:scott372199/album-infra:*` |
| `aws_iam_role` **gha_infra_apply** | 可写基础设施资源；同上 trust |
| `aws_iam_role` **gha_app_deploy** | 仅站点桶写 + `cloudfront:CreateInvalidation`；trust 限定 `repo:scott372199/album:*` |

- **鸡生蛋处理**：bootstrap 首次以本地 state 执行；成功后再 `terraform init -migrate-state` 把自身 state 迁入刚建好的桶，此后位置唯一。
  *Chicken-and-egg: bootstrap first runs with local state, then `terraform init -migrate-state` moves its own state into the bucket it just created.*

### 3.2 L1 storage

| 资源 / Resource | 关键参数 / Key settings |
| --- | --- |
| `aws_s3_bucket` **site**（**import** `chenyouyi`） | 私有；PAB 全开；SSE-S3；**不设**生命周期 |
| `aws_s3_bucket_policy` **site** | 仅允许 `cloudfront.amazonaws.com`，条件 `AWS:SourceArn` = 分发 ARN |
| `aws_s3_bucket` **source**（新建 / new） | 私有；PAB 全开；SSE-S3；**不开版本控制**（见下方说明）；生命周期：对象 30 天后过期兜底 |
| `aws_s3_bucket_cors_configuration` **source** | `AllowedOrigins=[https://photos.chenyouyi.top]`，`Methods=[PUT]`，`AllowedHeaders=["*"]`，`ExposeHeaders=[ETag]` |
| `aws_s3_bucket` **downloads**（新建 / new） | 私有；PAB 全开；SSE-S3；经 CDN `/apk/*` 暴露 |

> **CORS 是必须的**：WebView 里的页面源是站点域名，直传 S3 属跨域请求。
> ***CORS is mandatory**: the page origin inside the WebView is the site domain, so direct-to-S3 upload is a cross-origin request.*

> **源桶为什么必须关版本控制**：`DeleteObject` 在开启版本控制的桶里只会写入一个删除标记，原图作为历史版本仍然存在——「删了」是错觉。既然 P02 的目标是让原始 GPS 不在云上留存，版本控制就必须关闭。代价是无法恢复误删，但对象键本身是内容哈希，不存在覆盖问题。
> ***Why versioning must be off**: in a versioned bucket `DeleteObject` only writes a delete marker — the original survives as a non-current version, so "deleted" would be an illusion. Since P02 aims to keep GPS off the cloud, versioning must be off. The cost is no undelete, but keys are content hashes, so overwrites aren't a concern.*

> **生命周期是兜底而非主路径**：正常路径由处理函数显式删除；生命周期只负责清理「处理失败且重试耗尽」的残留，避免成堆的孤儿原图。30 天是上限，不是保留期。
> ***Lifecycle is a backstop, not the main path**: the processor deletes explicitly; lifecycle only sweeps objects whose processing failed and exhausted retries. 30 days is a ceiling, not a retention period.*

### 3.3 L2 edge

| 资源 / Resource | 关键参数 / Key settings |
| --- | --- |
| `aws_cloudfront_origin_access_control`（**import** `EQAKQ33RBCH5M`） | `s3` / `always` / `sigv4` |
| `aws_cloudfront_distribution`（**import** `E2UWEFMOKOQEES`） | 默认根对象 `index.html`；`PriceClass_200`；`us-east-1` 证书；HTTP→HTTPS 重定向；**不配** CustomErrorResponses |
| 默认行为 / Default behavior | 源=site；`Managed-CachingOptimized`；允许 GET/HEAD；压缩开 |
| 有序行为 `/apk/*` | 源=downloads；长 TTL；不压缩（APK 已压缩） |
| `data "aws_acm_certificate"` | 按域名 + `statuses=["ISSUED"]` 查现有证书 |

> **证书用 data source 而非 import**：不纳入 state 管理，就不可能被误删或误替换；续期本就由 ACM 自动完成。这是对 spec D-12 的实现细化，需你确认（见 §16-P01）。
> ***Cert referenced via data source, not imported**: if it is never in state, it can never be accidentally replaced. Renewal is already handled by ACM. This refines spec D-12 and needs your nod (§16-P01).*

### 3.4 L3 compute

| 资源 / Resource | 关键参数 / Key settings |
| --- | --- |
| `aws_ecr_repository` **processor** | 名 `album-processor`；`image_tag_mutability=IMMUTABLE`；扫描开 |
| `aws_lambda_function` **auth** | 同一镜像，`image_config.command=["auth/handler.handler"]`；512MB；超时 10s |
| `aws_lambda_function` **processor** | 同一镜像，`command=["processor/handler.handler"]`；3008MB；超时 900s；`/tmp` 4096MB；**reserved concurrency = 1** |
| `aws_s3_bucket_notification`（source） | `s3:ObjectCreated:*`，前缀 `incoming/` → processor |
| `aws_lambda_function_event_invoke_config` | processor 异步重试 2 次；目标 → SQS |
| `aws_sqs_queue` **dlq** | 保留 14 天 |
| `aws_apigatewayv2_api` **album-api** | HTTP API；stage `prod`；节流 5 rps / burst 10 |
| 路由 / Routes | `POST /auth`、`POST /upload-url`、`GET /health` |
| `aws_dynamodb_table` **auth_attempts** | 名 `album-auth-attempts`；PAY_PER_REQUEST；TTL 开；记录失败次数 |
| `aws_ssm_parameter` ×3 | `/album/auth/phones`、`/album/auth/key_hash`、`/album/auth/jwt_secret`，均 SecureString |
| `aws_iam_role` ×2 | auth 只读 SSM；processor 读写两桶 + 失效 CDN |
| `aws_cloudwatch_log_group` ×2 | 保留 14 天 |

> **为什么两个函数共用一个镜像**：sharp 与 ffmpeg 的依赖完全重叠，一个镜像两个入口省一次构建与一份存储，且版本严格一致。
> ***Why one image, two functions**: sharp and ffmpeg dependencies overlap entirely; one image with two entrypoints saves a build and keeps versions locked together.*

### 3.5 层间数据流 / Data flow between layers

| 从 / From | 到 / To | 传递内容 / Passed |
| --- | --- | --- |
| L0 | 全部 | 角色 ARN、state 桶名、锁表名 |
| L1 | L2 | 三个桶的 `bucket_regional_domain_name` 与 ARN |
| L1 | L3 | 两桶名（源/站点） |
| L2 | L3 | 分发 ID（失效用） |

依赖方向严格单向，禁止反向引用。
*Dependencies are strictly one-way; back-references are forbidden.*

---

## 4. 模块与接口 / Modules & Interfaces

| 模块 / Module | 输入（要点） / Inputs | 输出 / Outputs |
| --- | --- | --- |
| `private-bucket` | `name`, `versioning`, `lifecycle_rules`, `cors`, `policy_json` | `id`, `arn`, `regional_domain_name` |
| `cdn-site` | `aliases`, `cert_arn`, `origins[]`, `default_behavior`, `ordered_behaviors[]`, `oac_id` | `distribution_id`, `domain_name`, `arn` |
| `lambda-container` | `name`, `image_uri`, `command`, `memory`, `timeout`, `env`, `reserved_concurrency`, `dlq_arn` | `function_arn`, `invoke_arn`, `role_arn`, `name` |
| `http-api` | `routes[]`, `cors`, `throttling`, `stage` | `api_endpoint`, `api_id` |
| `secure-params` | `params`（map：name→value）, `tier` | `arns`（map） |
| `bucket-notification` | `bucket`, `lambda_arn`, `prefix`, `events` | `notification_id` |

**模块纪律** / **Module discipline**：
1. 模块内不出现任何环境字面量；桶名、域名、ARN 一律由调用方注入。
   *No environment literals inside modules; names, domains and ARNs are always injected.*
2. 每个模块必须有 `variables.tf`（带 `type`/`description`/必要 `validation`）与 `outputs.tf`。
3. **edge 层不套社区 CloudFront 模块**：为把既有分发调到 `plan` 为空，直接写资源更可控（spec §11.10）。
   ***The edge layer does not use a community CloudFront module**: aligning an existing distribution to an empty plan is more controllable with explicit resources.*

---

## 5. 参数（变量）清单 / Parameters & Variables

### 5.1 通用变量 / Common variables

| 变量 / Variable | 类型 / Type | 示例值 / Example | 说明 / Notes |
| --- | --- | --- | --- |
| `aws_region` | string | `ap-southeast-1` | 主区域；校验白名单 |
| `aws_region_edge` | string | `us-east-1` | CDN 与证书固定区域 |
| `project` | string | `album` | 命名与标签前缀 |
| `domain_name` | string | `photos.chenyouyi.top` | 站点域名 |
| `account_id` | string | `156487532333` | 跨层传参，不硬编码在模块里 |

### 5.2 各层专属 / Per-layer

| 层 / Layer | 变量 / Variables |
| --- | --- |
| L0 | `state_bucket_name`, `lock_table_name`, `github_org`, `app_repo`, `infra_repo` |
| L1 | `site_bucket_name`, `source_bucket_name`, `download_bucket_name`, `noncurrent_expire_days`, `cors_origins[]`, `distribution_arn`（策略条件用，可为空则后置补齐） |
| L2 | `aliases[]`, `default_root_object`, `price_class`, `apk_path_pattern`, `apk_ttl_seconds` |
| L3 | `image_uri`, `image_tag`, `processor_memory`, `processor_timeout`, `processor_concurrency`, `api_throttle_rps`, `api_throttle_burst`, `phones_hash[]`, `log_retention_days` |

### 5.3 敏感值处理 / Handling secrets

敏感值**不进 tfvars**，也不进 state：
*Secrets never enter tfvars, and never enter state:*

| 值 / Value | 存放 / Stored in | 写入方式 / How written |
| --- | --- | --- |
| 手机号哈希列表 | SSM SecureString | `ignore_changes = [value]`，由脚本单独写入 |
| 共享密钥哈希 | SSM SecureString | 同上 |
| JWT 签名密钥 | SSM SecureString | 同上（随机 32 字节） |

> 用 `ignore_changes` 的意义：Terraform 只负责「参数存在且加密」，不负责「参数的值」，避免明文进 state 与 git。
> ***Why `ignore_changes`**: Terraform owns "the parameter exists and is encrypted", not "its value" — keeping plaintext out of state and git.*

### 5.4 输出变量 / Outputs

每层 `outputs.tf` 必须写明 `description`；跨层的 ARN / ID 输出标记 `sensitive = false`（非机密），密钥类输出一律 `sensitive = true` 且不跨层使用。
*Every layer must document outputs; key-like outputs are marked sensitive and never shared across layers.*

---

## 6. 既有资源导入方案 / Importing Existing Resources

### 6.1 导入清单 / Import list

| 资源 / Resource | 导入 ID / Import ID | 层 / Layer | 备注 / Notes |
| --- | --- | --- | --- |
| `aws_s3_bucket` site | `chenyouyi` | L1 | 仅桶本体，附属配置需分别导入 |
| `aws_s3_bucket_public_access_block` site | `chenyouyi` | L1 | 现状四项全 true |
| `aws_s3_bucket_server_side_encryption_configuration` site | `chenyouyi` | L1 | 若未设加密则新建而非导入 |
| `aws_s3_bucket_policy` site | `chenyouyi` | L1 | 现存 OAC 策略 |
| `aws_cloudfront_origin_access_control` | `EQAKQ33RBCH5M` | L2 | 支持 import block |
| `aws_cloudfront_distribution` | `E2UWEFMOKOQEES` | L2 | **风险最高**，见 6.3 |
| `aws_acm_certificate` | —（用 data source） | L2 | 不导入，只引用 |

### 6.2 导入的做法 / How importing is done

用 Terraform 1.5+ 的 `import` 块（声明式，可 review、可复现），而不是命令行 `terraform import`：
*Use Terraform 1.5+ `import` blocks (declarative, reviewable, reproducible) rather than the CLI:*

```hcl
import {
  to = module.site_bucket.aws_s3_bucket.this
  id = "chenyouyi"
}
```

导入完成、`plan` 为空后，**删除 import 块**并提交——此后该资源由代码正常管理，避免 import 块长期残留造成误导。
*After import and a clean plan, **remove the import block** and commit: from then on the resource is managed normally.*

### 6.3 CloudFront 分发的对齐策略 / Aligning the distribution

这是全项目风险最高的一步。做法：
*This is the riskiest step in the whole project. The approach:*

1. 先 `terraform plan` 看差异，**只读不改**，把差异逐条归类：默认值差异 / 真实配置差异 / 无法表达的字段。
   *Run `plan` first, read-only, and classify every diff: default-value noise, real config differences, fields Terraform cannot express.*
2. 能为默认值的，显式写出来（例如 `http_version = "http2"`、`is_ipv6_enabled = true`）。
   *For default-value noise, write the effective value explicitly.*
3. 真实差异分两类处理：**IaC 现状对齐**（改代码）与**有意变更**（改资源，需单独一次 apply 且提前告知）。
   *Real differences split into "align code to reality" and "intentional change" — the latter needs its own apply and prior notice.*
4. `/apk/*` 有序行为**不在首次导入时加**：先让分发 `plan` 为空（零变更），再单独一次提交新增行为。这样若新增出问题，回退只需撤销那一个提交。
   *The `/apk/*` behavior is **not** added during the first import. Get a zero-diff plan first, then add it in a separate commit so rollback is one revert.*

### 6.4 每层的通过条件 / Gate per layer

| 层 / Layer | 通过条件 / Gate |
| --- | --- |
| L0 | `apply` 后 state 桶可读写，锁表可争用；三个角色可被 Actions 假定 |
| L1 | `plan` 为空；线上首页仍 200；直连 S3 仍 403 |
| L2 | `plan` 为空；正式域名 200；CF 默认域名 200；旧 HTTP 端点仍 404 |
| L3 | 全部资源为新建，`apply` 后 `plan` 为空；`/health` 返回 200 |

### 6.5 回滚 / Rollback

- 每层独立 state，回滚单位是**层**，不是全站。
  *Each layer has its own state; the rollback unit is a layer, not the whole site.*
- 导入阶段的回滚 = `terraform state rm` 该资源 + 撤回代码提交（资源本身从未被修改，无需恢复数据）。
  *Rollback during import = `state rm` the resource + revert the commit; nothing was modified, so no data restore is needed.*
- `apply` 阶段的回滚 = `git revert` + 重新 `plan` 确认 + `apply`。
- 任何会触及 edge 层的变更，执行前先用 `aws cloudfront get-distribution-config` 保存一份配置快照到本地（不入库）。
  *Before any change touching the edge layer, snapshot the live config locally (not in git).*

---

## 7. 服务端设计 / Server-side Design

### 7.1 接口契约 / API contract

**POST /auth**
```json
// request
{ "phone": "13800000000", "key": "<shared key>" }
// 200
{ "token": "<JWT, 1h>", "refresh": "<JWT, 7d>", "expiresIn": 3600 }
// 401
{ "error": "invalid_credentials" }   // 429: too_many_attempts
```

校验顺序：手机号哈希是否在白名单 → 共享密钥哈希是否匹配 → 失败计数是否超限。三条任一不通过都返回同一个错误码，不区分原因。
*Validation order: phone hash in allowlist → shared key hash match → failure counter under limit. Any failure returns the same code; reasons are not distinguished.*

**POST /upload-url**（`Authorization: Bearer <token>`）
```json
// request
{ "album": "2026", "files": [
  { "name": "IMG_0001.jpg", "size": 3487211, "sha256": "ab12…", "takenAt": "2026-11-11T09:12:00+08:00" }
]}
// 200
{ "items": [
  { "key": "incoming/ab12….jpg", "url": "https://…presigned…", "method": "PUT",
    "headers": { "Content-Type": "image/jpeg" }, "expiresIn": 900 }
]}
```

- 单次 ≤ 20 个；单图 ≤ 30MB；单视频 ≤ 200MB。超限整批拒绝并说明是哪一个。
  *≤20 files per call; ≤30MB per image; ≤200MB per video. Violations reject the batch and name the offender.*
- key 用 `sha256` 前 16 位 + 原扩展名，天然去重。
  *Keys use the first 16 hex chars of sha256 plus the original extension — dedupe comes for free.*
- 预签名有效期 15 分钟，`Content-Type` 参与签名，防止改成 HTML 上传。
  *Presigned URLs live 15 minutes; `Content-Type` is signed to prevent uploading HTML.*

**GET /health** → `{ "ok": true, "v": "4" }`

### 7.2 令牌 / Tokens

- HS256，密钥存 SSM；`sub` = 手机号哈希（不存明文号）。
  *HS256 with the secret in SSM; `sub` is the phone hash, never the plaintext number.*
- 访问令牌 1h，刷新令牌 7d；客户端在 401 时用刷新令牌换新，失败才要求重新登录。
- 令牌只放 `Authorization` 头，不进 URL、不进日志。
  *Tokens live only in the `Authorization` header — never in URLs, never in logs.*

### 7.3 处理函数 / Processor

触发：`incoming/` 前缀的新对象。步骤：
*Trigger: a new object under the `incoming/` prefix. Steps:*

1. 取对象，算 SHA256，若站点桶已有同 id 产物 → 直接结束（幂等）。
   *Fetch, hash; if outputs for this id already exist, stop (idempotent).*
2. 判定类型：`image/*` 或 `video/*`；其余拒收并记录。
3. 图片：`sharp` → `thumb.webp`(320w) + `view.webp`(2048 长边)，**不调用 `withMetadata`**，输出后断言无 EXIF。
   *Image: sharp → thumb 320w + view 2048 long edge, no `withMetadata`; assert no EXIF afterwards.*
4. 视频：`ffprobe` 取宽高/旋转/时长 → `-map_metadata -1 -fflags +bitexact` 转 H.264 1080p/≤30s/crf23 → 抽封面帧转 webp。
5. 拍摄年月：`takenAt`（客户端）→ EXIF `DateTimeOriginal` → 对象 `LastModified`。**只保留年月**。
6. 写产物到站点桶：`media/<id>/thumb.webp`、`view.webp`、`poster.webp`、`clip.mp4`，均带长缓存头。
7. 读当前清单 → 追加/替换条目 → 写新清单 `data/manifest.<hash>.json` → 更新 `data/version.json`。
8. 失效 `/` 与 `/data/version.json`。
9. **删除源桶对象**（P02，必做）。放在最后一步：先确认产物与清单都写成功，再删原图；顺序反了就会丢素材。
   ***Delete the source object** (P02, mandatory). Done last: confirm both outputs and manifest are written before removing the original — reversing the order loses material.*

**并发与一致性**：reserved concurrency = 1，保证清单是「读-改-写」串行，不会互相覆盖。
***Concurrency**: reserved concurrency = 1 serializes the read-modify-write on the manifest.*

### 7.4 清单与版本文件 / Manifest & version file

```json
// data/version.json  (Cache-Control: no-store)
{ "v": "2026-11-11T12:00:00Z", "manifest": "data/manifest.a1b2c3d4.json" }
// data/manifest.<hash>.json  (immutable, 长缓存)
{ "photos": [ { "id": "a1b2c3d4", "y": 2026, "m": 11, "album": "2026",
                "kind": "image", "w": 4032, "h": 3024, "ar": 1.3333,
                "tags": ["家人"], "thumb": "media/a1b2c3d4/thumb.webp",
                "view": "media/a1b2c3d4/view.webp" } ],
  "albums": [ { "name": "2026", "count": 1, "cover": "a1b2c3d4" } ] }
```

- 清单文件名带内容哈希 → 可永久缓存；`version.json` 不缓存 → 发布即生效。
  *Hashed manifest filenames allow immutable caching; `version.json` is no-store so publishing is instant.*
- 前端冷启动多一次往返（`version.json` → 清单），代价约一个 RTT，换取「Lambda 能增量发布」。
  *Cold start costs one extra round trip, in exchange for incremental publishing.*

### 7.5 失败处理 / Failures

| 情况 / Case | 处理 / Handling |
| --- | --- |
| 转码失败 | 异步重试 2 次 → 仍失败进 DLQ；站点上不出现该照片，**原图保留**在源桶供排查，30 天后由生命周期清除 |
| 视频超 15 分钟 | 直接放弃并记录，转封面图 |
| 清单写入冲突 | 由并发 1 消除；若仍冲突则整次重试 |
| 来源格式非法 | 不重试，直接进 DLQ |

---

## 8. 前端改造 / Frontend Changes

| 文件 / File | 改动 / Change |
| --- | --- |
| `src/build/build.mjs` | 增 `--target=web\|all`；web 模式跳过扫描与转码 |
| `src/web/js/data.js` | 先取 `version.json`，再按 `manifest` 字段取清单 |
| `src/web/js/upload.js`（新） | 登录、选图、HEIC→JPEG、预签名直传、四态进度 |
| `src/web/js/motion.js` | 增 `CSS.supports('animation-timeline: view()')` 守卫，不支持则直接全可见 |
| `src/web/index.html` | 移除清单注入占位；注入令牌端点与 APK 版本端点 |
| `src/web/app.js` | 挂 `window.__canGoBack()` 与 `window.AlbumNative` 桥（供安卓调用） |

**上传前转换**：`createImageBitmap` 解码 → `OffscreenCanvas` 重编码 JPEG q0.95，保持原像素尺寸；失败则原样上传并标注。
*Pre-upload conversion: decode via `createImageBitmap`, re-encode with `OffscreenCanvas` at q0.95, original dimensions preserved; on failure upload as-is and flag it.*

**上传入口可见性**：仅在检测到原生桥且持有有效令牌时渲染。
*Upload entry renders only when the native bridge exists and a valid token is held.*

---

## 9. 安卓客户端 / Android Client

### 9.1 工程 / Project

| 项 / Item | 取值 / Value |
| --- | --- |
| 包名 / Package | `top.chenyouyi.album` |
| minSdk / targetSdk | 26 / 35 |
| 语言 / Language | Kotlin，单 Activity |
| 构建 / Build | Gradle 8.x + AGP 8.x；命令行构建，不装 Android Studio |
| 产物 / Artifact | `app-release.apk`（签名）+ `version.json`（versionCode/versionName/url/sha256） |

### 9.2 关键配置 / Key settings

```kotlin
webView.settings.apply {
    javaScriptEnabled = true
    domStorageEnabled = true
    mediaPlaybackRequiresUserGesture = false
    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    cacheMode = WebSettings.LOAD_DEFAULT
}
```

| 需求 / Requirement | 实现 / Implementation |
| --- | --- |
| 全屏沉浸 | `WindowCompat.setDecorFitsSystemWindows(false)` + 透明状态栏 |
| 返回键 | `OnBackPressedCallback` → `evaluateJavascript("window.__canGoBack()")`，true 则 `goBack()` |
| 选图 | `WebChromeClient.onShowFileChooser` + `PickMultipleVisualMedia` |
| 常亮 | 原生桥 `setKeepScreenOn` → `FLAG_KEEP_SCREEN_ON`（比 Wake Lock 更可靠） |
| 应用内更新 | `version.json` 比对 versionCode → `DownloadManager` → `FileProvider` → `ACTION_VIEW` |
| 离线 | `onReceivedError` → 加载内置 `offline.html` |

> **常亮优先用原生标志位**：WebView 里的 Screen Wake Lock 受页面可见性与安全上下文影响，原生 `FLAG_KEEP_SCREEN_ON` 不受这些限制，这正是 v3 里最不确定的一环。
> ***Prefer the native flag**: the web Wake Lock API depends on page visibility and secure context; `FLAG_KEEP_SCREEN_ON` does not — this removes v3's least-certain behaviour.*

### 9.3 签名与分发 / Signing & distribution

- 生成 `album-release.keystore`（RSA 4096，25 年），口令与文件由用户离线备份，**均不入库**。
- APK 上传到 downloads 桶：`apk/album-<versionCode>.apk` + `apk/version.json`。
- 应用内更新校验下载文件的 sha256 后再调起安装器。
  *Verify sha256 of the downloaded APK before invoking the installer.*

---

## 10. 自动化 / Automation

### 10.1 内容发布（应用仓库）/ Content deploy (app repo)

```yaml
# .github/workflows/deploy-web.yml
on:
  push:
    branches: [main]
    paths: ["src/web/**", "src/build/**", "site.json", "package.json", "package-lock.json"]
permissions: { id-token: write, contents: read }
concurrency: { group: deploy-web, cancel-in-progress: false }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup-node 22 + npm ci
      - npm run build:web
      - node scripts/verify.mjs            # 结构断言，失败即停
      - aws-actions/configure-aws-credentials@v4 (OIDC → gha_app_deploy)
      - aws s3 sync dist/ s3://<site>/ --delete --size-only --exclude ".build-report.json"
      - aws s3 cp dist/index.html s3://<site>/index.html --cache-control "no-cache"
      - aws s3 cp dist/data/version.json s3://<site>/data/version.json --cache-control "no-store"
      - aws cloudfront create-invalidation --paths "/" "/data/version.json"
      - 线上自检（入口页 200 + 清单可取 + 抽样图片 200）
```

- **两段式缓存头**必须保留（v3 踩过：`--exclude` 影响 `--delete` 判定）。
  *The two-phase cache-header step must stay (v3 lesson: `--exclude` affects `--delete`).*
- 失败即中断；线上保持上一版本（S3 同步是覆盖式，但入口页最后才覆盖，故旧页面仍可用）。
  *Fail fast; the site stays on the previous version because `index.html` is overwritten last.*

### 10.2 基础设施（infra 仓库）/ Infrastructure (infra repo)

```yaml
# .github/workflows/infra.yml
on:
  pull_request: { paths: ["layers/**", "modules/**"] }
  push: { branches: [main], paths: ["layers/**", "modules/**"] }
permissions: { id-token: write, contents: read, pull-requests: write }
concurrency: { group: infra, cancel-in-progress: false }
jobs:
  plan:
    strategy: { matrix: { layer: [00-bootstrap, 10-storage, 20-edge, 30-compute] } }
    steps: [checkout, setup-terraform, fmt -check, init, validate, plan -out, 上传 plan 为 artifact]
  apply:
    needs: plan
    if: github.ref == 'refs/heads/main'
    environment: production        # 保护环境：必需审核人 = 你
    strategy: { matrix: { layer: [...] }, max-parallel: 1 }
    steps: [下载 plan artifact, terraform apply <plan>]
```

- `pull_request` 只走 plan，绝不 apply。
  *Pull requests only get plans, never applies.*
- `max-parallel: 1` + `concurrency` 双重保证不并发改 state。
- 无差异的层：`plan` 退出码 0 且无变更 → 跳过 apply（`terraform show -json` 判断，或 `-detailed-exitcode` 返回 0 即无变更）。
  *Layers with no diff skip apply: `-detailed-exitcode` returning 0 means no changes.*

### 10.3 OIDC 与权限 / OIDC & permissions

| 角色 / Role | 假定方 / Assumed by | 权限 / Permissions |
| --- | --- | --- |
| `gha_app_deploy` | `album` 仓库 main | 站点桶写 + `cloudfront:CreateInvalidation`（限该分发） |
| `gha_infra_plan` | `album-infra` 任意 ref | 只读全量 + state 桶读写 |
| `gha_infra_apply` | `album-infra` main（保护环境） | 基础设施写权限 |

信任策略按 `sub` 收紧到具体仓库与分支，不用通配。
*Trust policies are scoped by `sub` to specific repos and branches — no wildcards.*

---

## 11. 隐私与安全设计 / Privacy & Security Design

| 控制点 / Control | 做法 / Implementation |
| --- | --- |
| 脱敏发生点 | 只在 processor 里；产物一律重编码且不写元数据 |
| 源桶 | 私有、SSE-S3、PAB 全开、仅 processor 角色可写、**不开版本控制**、处理成功即删对象 |
| 手机号 | 只存 `sha256(salt + phone)`；日志只输出前 6 位掩码 |
| 共享密钥 | 只存 scrypt 哈希；客户端输入后存 `EncryptedSharedPreferences` |
| JWT 密钥 | SSM SecureString，绝不进 tfvars / state / 代码 |
| 接口 | API 限流 5rps；登录失败 5 次锁 15 分钟（DynamoDB + TTL） |
| 令牌 | 1h/7d；仅 Authorization 头 |
| APK 签名 | keystore 不入库；口令由用户保管 |
| 仓库 | infra 私有；两仓库均不得出现 state、密钥、照片 |

**P02 定案后，隐私事实变好了**：原图只在源桶停留「上传→处理完成」这一小段时间，随后即被删除；系统内不长期存放含 GPS 的原始文件。代价是源桶不再承担备份职责，灾后重建只能重新导入。
***Privacy improved with P02**: originals live in the source bucket only between upload and successful processing, then are deleted. No long-lived copy with GPS exists anywhere in the system. The cost is that the source bucket no longer serves as a backup.*

---

## 12. 迁移顺序与回滚 / Migration Order & Rollback

| 步 / Step | 内容 / Action | 通过条件 / Gate | 回滚 / Rollback |
| --- | --- | --- | --- |
| M0 | 装 terraform；建私有仓库 `album-infra`；L0 骨架 | `apply` 成功，state 迁入自建桶 | `state rm` + 删仓库 |
| M1 | L1 导入 site 桶与附属配置；新建 source/downloads 桶 | L1 `plan` 为空；首页仍 200；直连 S3 仍 403 | 撤回提交（资源未改） |
| M2 | L2 导入 OAC + 分发（**不加** `/apk/*`） | L2 `plan` 为空；正式域名 200 | 撤回提交 |
| M3 | L2 追加 `/apk/*` 行为与新源站 | `plan` 只含新增；`/apk/health.txt` 可取 | revert 该提交 + apply |
| M4 | L3 建 ECR + Lambda + API + DynamoDB + SQS + SSM | `/health` 200；`plan` 为空 | 整层 destroy（全新资源） |
| M5 | 前端改造 + `build:web` + 运行时清单；接入发布 workflow | 合并 main 后 5 分钟内自动上线 | 回退提交；Lambda 未启用则清单仍静态 |
| M6 | 手机上传链路联调（auth → 直传 → 处理 → 上线） | 5 张照片 60s 内可见，无 EXIF | 停用 S3 事件通知 |
| M7 | 安卓 App 构建、签名、上架下载桶、应用内更新 | 两台真机验收 §9-A | 保留旧 APK |
| M8 | 删除 `src/deploy/*` 资源脚本；收尾文档 | 仓库无资源管理脚本；`plan` 仍为空 | revert |

**原则**：M1~M3 只做「认领」，不做功能变更；M4 之后才引入新能力。任何一步失败都停在那一步，不带着问题往下走。
***Principle**: M1–M3 only adopt existing resources, adding no behaviour. New capability starts at M4. Any failure stops at that step.*

---

## 13. 验证策略 / Verification Strategy

| 层 / Level | 手段 / Method |
| --- | --- |
| 结构 / Structure | 扩充 `scripts/verify.mjs`：清单装载方式、模块导入导出一致性、无硬编码桶名、上线产物无 `http://` |
| IaC 静态 / IaC static | `terraform fmt -check`、`validate`；无凭证也能跑 |
| IaC 差异 / IaC diff | 逐层 `plan`，无变更时必须 `-detailed-exitcode=0` |
| 接口 / API | 本地对 handler 单测（伪造事件）；线上 `curl /health` |
| 处理函数 / Processor | 用真实样本（含一张带 GPS 的 JPEG、一段竖屏 MOV）跑本地容器 |
| 视觉 / Visual | Chrome 无头截图（沿用 v3 手法）对比改造前后差异 |
| 真机 / Device | 荣耀 / 小米 / 三星各一台；含断网、返回键、常亮、安装更新 |

---

## 14. 成本 / Cost

与 spec §12 一致，明细：
*Consistent with spec §12; detail:*

| 项 / Item | 月费 / Monthly |
| --- | --- |
| S3（站点 + 源 + 下载 + state） | ¥3~8 |
| CloudFront 请求与流量 | ¥1~3 |
| Lambda（低频） | ≈ ¥0（免费额度内） |
| API Gateway | ≈ ¥0 |
| ECR（1GB） | ¥0.7 |
| DynamoDB（按需，极小） | ≈ ¥0 |
| SSM（标准参数免费） | ¥0 |
| GitHub Actions | ¥0 |
| **合计 / Total** | **¥5~12** |

---

## 15. 风险登记 / Risk Register

| # | 风险 / Risk | 影响 / Impact | 应对 / Mitigation |
| --- | --- | --- | --- |
| R1 | CloudFront 导入产生无法消除的 diff | 可能误改分发导致断站 | 只读 plan 先行、快照现存配置、`/apk/*` 单独提交、逐字段对齐 |
| R2 | 国产 WebView 内核版本过旧 | 动效降级或白屏 | 能力检测 + 直接可见降级；真机三台验收 |
| R3 | lambda 冷启动 + ffmpeg 体积大 | 视频处理首帧慢 | 镜像分层缓存；视频超时降级为封面 |
| R4 | 手机端 HEIC 转换失败 | 上传失败 | 失败时原样上传，由服务端 JPEG 兜底或进 DLQ |
| R5 | 清单写入并发冲突 | 丢照片条目 | reserved concurrency = 1 |
| R6 | 共享密钥泄露 | 陌生人可上传 | 换密钥 + 失效令牌；失败锁定；限流 |
| R7 | Actions 额度耗尽 | 无法自动发布 | O-23 降级本机执行同一命令 |
| R8 | Terraform state 误删 | 代码失去描述 | state 桶版本控制 + README 恢复步骤 |
| R9 | 源桶误开版本控制导致「删了没删掉」 | 原图长期留存，隐私承诺落空 | Terraform 显式 `aws_s3_bucket_versioning = Disabled`；上线后用 `list-object-versions` 验证删除后无历史版本 |

---

## 16. 待确认 / Open Questions

| 编号 / ID | 问题 / Question | 默认 / Default |
| --- | --- | --- |
| P01 | ACM 证书用 `data` 引用还是 `import` 纳管 | 用 `data`（不会被误删/误替换） |
| P02 | 处理成功后是否删除源桶原图 | **已定案：删除**；源桶不开版本控制，生命周期 30 天兜底（§3.2） |
| P03 | 上传失败重试次数 | 异步 2 次，之后进 DLQ |
| P04 | 是否使用 KMS 自定义密钥 | 不用，SSE-S3 足够（成本与复杂度更低） |
| P05 | APK 命名 | `apk/album-<versionCode>.apk` + `apk/version.json`；不保留 latest 副本，避免歧义 |
| P06 | 前端是否显示「上传成功」的独立页面 | 不显示，回到网格并高亮新照片 |
| P07 | 是否保留 `npm run deploy` 作为本地应急发布 | 保留，但只做内容同步（不含资源管理） |

---

## 17. 下一步 / Next

1. 本文确认后写 `spec/v4/tasks.md`（任务拆分、依赖、检查点、追溯）。*Once confirmed, write `spec/v4/tasks.md`.*
2. tasks 确认后进入实现，从 M0 开始。*Implementation starts at M0 after tasks are confirmed.*
