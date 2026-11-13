# 个人相册 · 第五版需求规范 / Personal Album · Version 5 Specification

> Spec-Driven Development · 阶段 1 / 5（Specify） / Stage 1 / 5 (Specify)
> 状态：**已确认** / Status: **Confirmed**
> 日期 / Date: 2026-11-12
> 确认 / Confirmed: 2026-11-12，进入 Plan 阶段 / entered the Plan stage
> 上游 / Baseline: v4 已完成验收；当前系统说明以 [`docs/`](../../docs/) 为准。
> *v4 has passed acceptance; [`docs/`](../../docs/) is the source of truth for the current system.*

## 1. V5 目标 / V5 Goals

V5 聚焦四条主线：Apple 风格的前端体验、基于图像语义的搜索、Java 管理平台、基础设施与
可观测性演进。它不是重写 v4，而是在保持公开浏览、上传链路、隐私红线和低成本目标不变的
前提下，增加可解释、可回退、可扩展到多云的能力。

*V5 focuses on an Apple-inspired frontend, image-semantic search, a Java management platform,
and infrastructure/observability evolution. It is an additive iteration, not a v4 rewrite;
public browsing, upload flow, privacy boundaries and the low-cost target remain unchanged.*

### 成功标准 / Success criteria

1. 首页具有 Apple 官网式的极简、科技感和未来感：顶部菜单、多个动态大图/章节切换，
   在移动端和桌面端保持清晰、流畅和可访问。
   *The home page has an Apple-inspired minimalist, technological and futuristic feel with a
   top navigation and multiple dynamic hero sections, while remaining clear, smooth and accessible.*
2. 用户可以用「湖水」「山峰」「蓝天」「汽车」「摩托车」「红色衬衫」「2025 年」等自然语言
   搜索图片特征。
   *Users can search image features with natural language such as lake, mountain, blue sky, car,
   motorcycle, red shirt and 2025.*
3. 管理站可以统一查看和操作 CI/CD、资源、日志、指标、安全和账单，并为 Azure/GCP 扩展预留边界。
   *The management site can provide one place for CI/CD, resources, logs, metrics, security and
   billing, with boundaries reserved for Azure/GCP integration.*
4. 关键上传、处理、发布与基础设施变更都有结构化证据，能回答「发生了什么、影响了什么、是否恢复」。
   *Critical upload, processing, publishing and infrastructure changes produce structured evidence answering what happened, what was affected and whether recovery occurred.*
5. 基础设施变更保持分层、最小权限、可计划（plan）和可回滚，不把内容对象交给 Terraform 管理。
   *Infrastructure remains layered, least-privileged, planable and reversible; Terraform still does not manage content objects.*

## 2. 范围 / Scope

### FR-01 前端体验 / Frontend experience

- 保持原生 ESM、无框架、无前端运行时依赖。
  *Keep vanilla ESM, no framework and no frontend runtime dependencies.*
- 视觉方向参考 `apple.com`：极简、科技感、未来感、强留白、清晰层级和高质量大图叙事；
  顶部菜单固定为主要导航入口。
  *The visual direction references apple.com: minimal, technological, futuristic, generous whitespace,
  clear hierarchy and large-image storytelling, with a top navigation as the primary entry point.*
- 首页支持多个动态大图/章节切换，动效必须支持 reduced-motion、低性能设备降级和键盘/触摸操作。
  *The home page supports multiple dynamic hero sections; motion must support reduced-motion, low-performance
  fallback and keyboard/touch interaction.*
- 优化首屏、懒加载、灯箱、照片墙、筛选和上传状态的感知性能；不得以降低图片质量或裁切照片换取速度。
  *Improve perceived performance for first paint, lazy loading, lightbox, wall mode, filtering and upload status without reducing image quality or cropping photos.*
- 上传状态必须明确区分：等待、上传中、处理中、已上线、失败；失败信息可操作且不泄露内部凭据或实现细节。
  *Upload status must distinguish queued, uploading, processing, published and failed; failures must be actionable without exposing secrets or internal implementation details.*
- 保持现有 URL 状态、无障碍基础行为、`prefers-reduced-motion` 降级和 Android 原生桥契约。
  *Preserve URL state, baseline accessibility, reduced-motion fallback and the Android native bridge contract.*

### FR-02 图像语义搜索 / Image-semantic search

- 为图片生成可检索的语义特征，包括物体、场景、颜色、自然语言标签和可用的时间字段。
  *Generate searchable semantic features including objects, scenes, colors, natural-language labels and available time fields.*
- 搜索框支持自然语言查询，并将查询映射到可解释的检索条件；`2025 年`等时间条件沿用 manifest 的公开年月字段。
  *The search box accepts natural-language queries and maps them to explainable retrieval conditions; time queries such as 2025 reuse the public year/month fields.*
- 识别必须异步执行、幂等、可重试，并与现有 `album-processor` 的转码/脱敏失败路径隔离。
  *Recognition must be asynchronous, idempotent and retryable, isolated from the existing transcode/redaction failure path.*
- 识别输入只能使用已脱敏的派生图，不得把含 EXIF/GPS 的原图发送给第三方识别服务。
  *Recognition may use only redacted derivatives; originals containing EXIF/GPS must never be sent to a third-party recognition service.*
- 识别服务不可用时，照片仍必须按 v4 流程完成转码和上线；搜索不可用时，基础筛选仍可用。
  *Recognition outages must not block v4 publication; when semantic search is unavailable, baseline filtering remains usable.*

### FR-03 管理平台 / Management platform

- 新建独立 GitHub 项目 `album-mgmt`，使用 Java 实现管理网站，正式域名为 `https://cx.chenyouyi.top`。
  *Create a separate GitHub project named album-mgmt, implemented in Java and served at https://cx.chenyouyi.top.*
- 管理平台预留统一 provider abstraction：当前 AWS，未来可接入 Azure 和 GCP；云厂商差异不能泄漏到前端契约。
  *Reserve a provider abstraction for AWS now and Azure/GCP later; cloud-specific details must not leak into frontend contracts.*
- 管理功能分域：CICD、资源目录、日志、metrics、security、billing；每个域都必须有独立权限与审计记录。
  *Separate management domains into CI/CD, resource inventory, logs, metrics, security and billing, each with independent authorization and audit records.*
- 管理站不得直接持有长期云密钥；云操作必须通过短期凭证、受限后端角色或受控 GitHub/AWS API。
  *The management site must not hold long-lived cloud keys; cloud actions use short-lived credentials, restricted backend roles or controlled GitHub/AWS APIs.*

### FR-04 基础设施演进 / Infrastructure evolution

- 继续使用 `album-infra` 的四层边界；新增资源必须归属明确的 layer，禁止跨层循环依赖。
  *Keep the four-layer boundary in album-infra; every new resource must belong to an explicit layer with no cyclic cross-layer dependency.*
- 对新增组件提供 Terraform variables/outputs、最小 IAM policy、plan/apply 顺序和回滚路径。
  *Every new component needs Terraform variables/outputs, least-privilege IAM, plan/apply ordering and a rollback path.*
- 优先演进现有 S3/Lambda/SQS/CloudWatch 方案；除非有量化收益，不引入常驻服务器、Kubernetes 或新的 CI/CD 平台。
  *Prefer evolving S3/Lambda/SQS/CloudWatch; do not introduce always-on servers, Kubernetes or another CI/CD platform without quantified benefits.*
- 基础设施变更继续采用「自动 plan、人工确认 apply」；应用内容发布与 Terraform 资源变更保持隔离。
  *Keep automatic plan plus human-approved apply; content publishing remains separate from Terraform resource changes.*

### FR-05 可观测性 / Observability

- 统一上传、处理、识别、清单发布、CDN 失效、CICD 和基础设施变更的 correlation ID，并在跨服务日志中传递。
  *Propagate one correlation ID across upload, processing, recognition, manifest publication, CDN invalidation, CI/CD and infrastructure changes.*
- 结构化日志必须包含事件名、阶段、结果、耗时、对象 key 的安全摘要和错误分类；不得记录手机号、令牌、原图 URL 或密钥。
  *Structured logs must include event, stage, outcome, duration, safe object-key digest and error class; never log phone numbers, tokens, original URLs or secrets.*
- 为成功率、处理延迟、识别延迟、DLQ 数量、重试次数、发布失败、CI/CD 结果和资源健康建立可查询的 metrics。
  *Expose queryable metrics for success rate, processing latency, recognition latency, DLQ depth, retries, deployment results and resource health.*
- 管理平台能够聚合 AWS 当前日志/metrics，并保留未来 Azure/GCP 的 provider-neutral 查询模型。
  *The management platform can aggregate current AWS logs/metrics while preserving a provider-neutral query model for Azure/GCP.*

### FR-06 交付治理 / Delivery governance

- 增加受保护分支和分支策略；功能分支必须通过 pull request 合并到 `main`。
  *Use protected branches and branch policies; feature branches merge into main through pull requests.*
- PR 合并前触发 GPT code review 和人工审核；未通过不得合并。
  *Before merge, trigger GPT code review and human approval; neither may be bypassed.*
- 合并到 `main` 后触发既有 CI/CD；失败时保留上一个可用版本。
  *After merge to main, trigger the existing CI/CD; on failure, retain the last known-good version.*
- GPT code review 的权限、提示数据范围和失败降级路径必须可审计，不能把秘密或原图发送给不必要的第三方。
  *GPT code review permissions, data scope and fallback behavior must be auditable; secrets and originals must not be sent to unnecessary third parties.*

## 3. 非目标 / Non-goals

- 不改变公开浏览模型，不新增浏览端账号体系。
  *No change to the public browsing model and no browser account system.*
- 不把原图长期留在云端，不放宽 EXIF/GPS/设备标识脱敏规则。
  *No long-term cloud retention of originals and no relaxation of EXIF/GPS/device-identifier redaction.*
- 不做照片删除、编辑、排序工作台，不在本轮重做视觉设计系统。
  *No photo delete/edit/reordering workstation and no full visual design-system rewrite.*
- 不在未确认数据边界、费用和隐私影响前绑定具体识别供应商；搜索必须保留无识别服务时的基础筛选降级。
  *Do not lock in a recognition vendor before data boundaries, cost and privacy impact are confirmed; baseline filtering must remain available without recognition.*
- 不以 Terraform 管理照片、manifest、APK 等内容对象。
  *Terraform must not manage photos, manifests, APKs or other content objects.*
- 不在 V5 第一阶段承诺一次性实现所有云厂商的完整资源管理；先定义 provider abstraction 和 AWS vertical slice。
  *Do not promise full resource management for every cloud provider in the first V5 phase; define the provider abstraction and deliver an AWS vertical slice first.*

## 4. 硬性不变量 / Hard invariants

1. 站点公开产物不含 GPS、设备序列号、原始文件名或具体拍摄时刻。
   *Public artifacts contain no GPS, device serial numbers, original filenames or exact capture timestamps.*
2. 识别失败不能阻塞照片上线；转码/脱敏失败不能生成坏清单条目。
   *Recognition failure must not block publication; transcode/redaction failure must not create broken manifest entries.*
3. 所有新写路径必须有明确的 prefix ownership、IAM owner 和失败落点。
   *Every new write path must have explicit prefix ownership, IAM ownership and a failure sink.*
4. 任何新指标或日志不得包含凭证、令牌、手机号或原图内容。
   *New metrics and logs must contain no credentials, tokens, phone numbers or original image content.*
5. 兼容现有 Android bridge、APK 更新链和 WebView 降级行为。
   *Existing Android bridge, APK update flow and WebView fallback behavior remain compatible.*

## 5. 待确认决策 / Decisions to confirm

### D-01 搜索特征 / Search features

已确认自然语言搜索是目标；Plan 阶段需要确定首批支持的特征集合、中文同义词处理、颜色/物体/场景
的索引方式，以及 `2025 年`这类时间条件如何与语义条件组合。

*Natural-language search is confirmed. The Plan stage must define the initial feature set, Chinese synonym handling,
object/scene/color indexing and composition with time conditions such as 2025.*

### D-02 识别 provider / Recognition provider

Plan 阶段比较 AWS 托管服务、容器内模型和外部 API；在比较完成前不默认把照片发送到外部服务。

*The Plan stage will compare an AWS-managed service, an in-container model and an external API; no external transfer
is assumed before that comparison is approved.*

### D-03 管理平台技术栈 / Management-platform stack

Java 实现已确认；Plan 阶段比较 Spring Boot、Micronaut、Quarkus 等运行时，以及前端形态、认证、provider
abstraction、部署位置和成本。管理平台默认先做只读 inventory/logs/metrics，再逐步开放受控操作。

*Java is confirmed. The Plan stage will compare Spring Boot, Micronaut and Quarkus, frontend options, authentication,
provider abstraction, deployment and cost. The default rollout starts with read-only inventory/logs/metrics before controlled actions.*

### D-04 可观测性与管理边界 / Observability and management boundary

默认优先 CloudWatch Logs Insights + CloudWatch metrics/alarms；管理站只聚合和编排，不绕过 GitHub branch protection、
Terraform plan/apply 或 AWS IAM。Azure/GCP 接入先定义统一资源、日志、metrics、billing 接口。

*The default is CloudWatch Logs Insights plus CloudWatch metrics/alarms. The management site aggregates and orchestrates
but does not bypass GitHub branch protection, Terraform plan/apply or AWS IAM. Azure/GCP integration starts with common
resource, log, metric and billing interfaces.*

### D-05 PR 治理 / PR governance

已确认：增加分支策略；PR 合并前同时需要 GPT code review 和人工审核；合并到 `main` 后触发 CI/CD。
Plan 阶段需确定 GitHub branch protection、review app、GPT review provider、权限范围和失败时是否阻断合并。

*Confirmed: add branch policy; require GPT code review and human approval before merge; trigger CI/CD after merging to main.
The Plan stage must define branch protection, review app, GPT provider, permissions and whether review failure blocks merging.*

## 6. 验收草案 / Draft acceptance criteria

- 前端：在目标移动端和桌面浏览器完成一次浏览、筛选、灯箱和上传；关键交互没有回归，失败状态可重试或解释。
  *Frontend: browsing, filtering, lightbox and upload work on target mobile and desktop browsers with no interaction regression and actionable failures.*
- 识别：一张脱敏后的测试图片产生可追踪的建议；重复触发不产生重复建议；识别失败时照片仍可上线。
  *Recognition: one redacted test image produces a traceable suggestion; duplicate triggers do not duplicate suggestions; the photo still publishes when recognition fails.*
- 隐私：识别请求与公开产物均通过 metadata/redaction 检查；日志与指标扫描无敏感字段。
  *Privacy: recognition inputs and public artifacts pass metadata/redaction checks; logs and metrics contain no sensitive fields.*
- 基础设施：每个新增 layer/module `fmt`、`validate`、offline checks 通过；plan 差异可解释，且有回滚演练记录。
  *Infrastructure: every changed layer/module passes fmt, validate and offline checks; plan differences are explainable and rollback is exercised.*
- 可观测性：从 correlation ID 能查到一次成功上传和一次失败进入 DLQ 的完整链路。
  *Observability: one correlation ID traces a successful upload and a failed upload entering the DLQ end to end.*
- 成本：新增能力的月度成本上限和按上传量的线性成本在 Plan 阶段量化，并保持总体目标 ≤ ¥15/月，除非另行确认。
  *Cost: fixed and per-upload costs are quantified in Plan and the total remains ≤ ¥15/month unless explicitly changed.*

## 7. 下一步 / Next step

你继续补充需求后，我会更新本 Spec；待你明确说「Spec 确认」后，才进入 Plan 阶段，分别给出：
Apple 风格前端方案、语义搜索方案对比、Java 管理站技术栈、provider abstraction、事件/日志契约、
Terraform 变更、PR/CICD 治理、成本模型、迁移顺序和回滚方案。

*After you finish adding requirements and explicitly confirm the Spec, the Plan stage will define the Apple-style
frontend, semantic-search options, Java management stack, provider abstraction, event/log contracts, Terraform changes,
PR/CI/CD governance, cost model, migration order and rollback plan.*
