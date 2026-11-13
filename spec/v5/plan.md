# 个人相册 · 第五版技术方案 / Personal Album · Version 5 Plan

> Spec-Driven Development · 阶段 2 / 5（Plan） / Stage 2 / 5 (Plan)
> 状态：**已确认** / Status: **Confirmed**
> 日期 / Date: 2026-11-12
> 确认 / Confirmed: 2026-11-12，进入 Tasks 阶段 / entered the Tasks stage
> 上游 / Upstream: [`spec.md`](./spec.md)（已确认 / confirmed）

本文描述如何实现 V5，不改变 [`spec.md`](./spec.md) 已确认的目标、边界和硬性不变量。

*This document describes how V5 will be implemented without changing the confirmed goals, boundaries or invariants in `spec.md`.*

## 1. 总体方案 / Overall approach

V5 拆成四个可独立交付的 capability slice：

1. **Experience slice**：Apple-inspired 首页、动态 hero、搜索 UI、性能和可访问性。
2. **Semantic search slice**：脱敏派生图 → 识别/embedding → 可解释索引 → 搜索 API → 前端结果。
3. **Management slice**：`album-mgmt` Java modular monolith，先只读，再逐步开放受控操作。
4. **Operations slice**：统一 correlation ID、结构化日志、metrics、告警、PR governance 和 CI/CD evidence。

*V5 is split into four independently deliverable capability slices: frontend experience, semantic search,
the Java management platform, and operational governance.*

第一阶段不做“大爆炸式平台”：先完成 AWS vertical slice，再用 provider-neutral contract 扩展 Azure/GCP。
管理平台第一版默认只读，避免一开始就拥有删除资源、修改 IAM 或直接 apply Terraform 的高风险权限。

*The first phase avoids a big-bang platform: deliver an AWS vertical slice first, then extend through
provider-neutral contracts. The first management release is read-only by default to avoid destructive
resource, IAM and direct Terraform apply privileges.*

## 2. 推荐技术栈与备选 / Recommended stack and alternatives

### 2.1 `album-mgmt` 后端 / Management backend

| 方案 / Option | 优点 / Strengths | 代价 / Trade-offs | 结论 / Decision |
|---|---|---|---|
| Spring Boot modular monolith | 生态最大、AWS/GitHub SDK 完整、团队可维护性高、模块边界清晰 | 内存与启动开销高于轻量框架 | **推荐 / Recommended** |
| Micronaut | 启动快、内存低、适合 serverless | 生态与团队样例少，部分库整合需额外验证 | 备选 / Alternative |
| Quarkus | native image 与 Lambda/Fargate 友好 | native build 链复杂，排错成本高 | 仅在成本/冷启动成为硬指标时评估 / Evaluate if required |

推荐：**Java 21 LTS + Spring Boot 当前受支持版本线 + Gradle Kotlin DSL + modular monolith**。
版本号在 T 阶段锁定，不在本计划中假设未来版本。

*Recommendation: Java 21 LTS, the currently supported Spring Boot line, Gradle Kotlin DSL and a
modular monolith. Exact versions are pinned during Tasks rather than guessed here.*

### 2.2 管理站前端 / Management frontend

推荐管理站前端独立于相册站点，采用 **TypeScript + React + Vite**，通过 Java API 访问统一 DTO。
相册主站继续保持原生 ESM，不引入 React；两者是不同产品、不同变更节奏。

*Use TypeScript, React and Vite for the management frontend, separated from the album site. The album
site remains vanilla ESM because the two products have different complexity and release cadence.*

备选是 Vue 3 或原生 TypeScript；只有在管理页面数量很少时才考虑原生方案。管理平台需要表格、
筛选、权限、审计和状态面板，使用成熟组件生态比复用相册前端约束更可靠。

*Vue 3 or vanilla TypeScript are alternatives, but a mature UI ecosystem is preferable for tables,
filters, permissions, audit and status dashboards.*

### 2.3 管理平台运行位置 / Management runtime

推荐第一版使用 **Spring Boot container + Amazon ECS Express Mode**，并为 `cx.chenyouyi.top` 创建独立的
CloudFront distribution。React 静态资源可放独立管理站 S3 origin，`/api/*` 指向 ECS Express Mode；
也可以由 Spring Boot 同时托管静态资源，Tasks 阶段用原型验证后定案。

TLS 在 CloudFront edge termination，沿用 `photos.chenyouyi.top` 的标准：ACM certificate 绑定
CloudFront，HTTP redirect 到 HTTPS；CloudFront 到 ECS Express Mode 使用 HTTPS origin，不把管理站降级为 HTTP。

*The first release uses a Spring Boot container on Amazon ECS Express Mode with a dedicated CloudFront distribution
for `cx.chenyouyi.top`. React assets may use a separate management-site S3 origin while `/api/*` routes to
ECS Express Mode; serving both from Spring Boot is also possible and will be decided after the prototype.
TLS terminates at the CloudFront edge using ACM, HTTP redirects to HTTPS, and the CloudFront-to-ECS Express Mode
origin connection remains HTTPS, matching the existing photos site standard.*

#### CloudFront 前面放什么 / What should sit behind CloudFront

| 组合 / Topology | 优点 / Pros | 缺点 / Cons | 结论 / Decision |
|---|---|---|---|
| CloudFront → ECS Express Mode | 保留简单部署；AWS 自动 provision Fargate、ALB、网络和 autoscaling；可继续扩展 ECS 能力 | 需管理 ECR、ECS IAM role 和底层资源成本 | **V5 prototype / 推荐** |
| CloudFront → ALB → ECS/Fargate | 私网任务、细粒度 routing/health check/security group；适合长期平台 | 维护 ECS/Fargate、ALB、target group；固定成本和运维面更大 | 后续规模化备选 |
| CloudFront → API Gateway → ECS Express Mode | API throttling、JWT authorizer、API policy 较方便 | 集成复杂；静态网站仍需另一条 origin；重复 edge layer | 只有 API policy 成为硬需求时采用 |

因此：**管理站原型使用 CloudFront → ECS Express Mode，不额外手写 ALB 或 API Gateway**。登录、授权和
rate limit 先在 Spring Security 与应用层实现；需要 API Gateway 的场景留在后续 ADR，不阻塞原型。

*Therefore the prototype uses CloudFront → ECS Express Mode without hand-managed ALB or API Gateway. Authentication,
authorization and rate limiting start in Spring Security and the application layer; API Gateway remains
a later ADR if edge API policy becomes necessary.*

`cx.chenyouyi.top` 与 `photos.chenyouyi.top` 使用完全独立的 CloudFront distribution、origin、cache
policy、certificate association、invalidation 和 Terraform state ownership，不复用 photos 的 distribution。

*`cx.chenyouyi.top` and `photos.chenyouyi.top` use separate CloudFront distributions, origins, cache policies,
certificate associations, invalidations and Terraform ownership; the management site does not share the album distribution.*

不推荐把管理站直接塞进现有 Lambda processor 镜像：管理 API 的生命周期、权限和发布风险与媒体处理不同。
也不推荐一开始上 Kubernetes。

*Do not place the management site inside the processor image; its lifecycle, permissions and release risks
differ from media processing. Kubernetes is also out of scope initially.*

## 3. 目标架构 / Target architecture

```text
Browser
  │
  ├── photos.chenyouyi.top
  │      └── CloudFront → S3 site → album web
  │
  └── cx.chenyouyi.top
         └── 独立 CloudFront → album-mgmt (Java/ECS Express Mode)
                                ├── GitHub adapter
                                ├── AWS adapter
                                ├── Observability adapter
                                ├── Billing adapter
                                ├── Audit store
                                └── Provider-neutral API

album upload → S3 source → processor → redacted derivatives
                                      ├── manifest / public assets
                                      └── recognition worker → search index
```

### 3.1 Java 管理平台模块 / Java management modules

`album-mgmt` 使用模块化单体，但 V5 第一阶段先做**可运行原型**：每个模块只提供最小页面、
真实 health/read API 和 mock/fixture 数据，先验证导航、信息架构、权限边界和用户反馈，再扩展完整功能。
模块之间只通过 application service 或 port interface 通信：

原型阶段**不引入新的数据库**：管理页面使用 mock/fixture，现有相册继续使用 S3 manifest、
DynamoDB 限流状态和 SQS 异步消息。未来需要持久化 RBAC、audit、search metadata 或 billing
snapshot 时，再通过 `PersistencePort` 接入 PostgreSQL；搜索先使用 PostgreSQL Full-Text Search，
后续按召回率和成本决定是否启用 `pgvector`。

*The prototype introduces no new database: management pages use mock/fixture data, while the album keeps
S3 manifests, DynamoDB rate-limit state and SQS messages. When persistent RBAC, audit, search metadata or
billing snapshots are needed, PostgreSQL is added behind a PersistencePort. Search starts with PostgreSQL
full-text search, with pgvector decided later by recall and cost.*

- `identity`：管理员登录、session/token、MFA extension point、角色和权限。
- `cicd`：GitHub repositories、branches、PR、checks、workflow runs。
- `inventory`：AWS resources、Terraform layers、ECR/Lambda/S3/CloudFront/DynamoDB/SQS/CloudWatch。
- `observability`：logs、metrics、traces/correlation lookup、health summary。
- `security`：IAM posture、secret metadata、branch protection、dependency/image scan summary。
- `billing`：AWS Cost Explorer read-only summary、budget threshold and anomaly status。
- `audit`：谁在什么时间查看或触发了什么动作，记录 request/correlation ID 和结果。
- `provider`：`CloudProvider`, `LogProvider`, `MetricProvider`, `BillingProvider` 等 port。

*The Java service is a modular monolith prototype with explicit ports for identity, CI/CD, inventory,
observability, security, billing, audit and cloud providers. Each module starts with a minimal real API
and fixtures; vendor SDKs stay behind adapters.*

### 3.2 多云抽象 / Multi-cloud abstraction

第一版只实现 AWS adapters。接口只暴露跨云稳定概念：

| Contract | Common model |
|---|---|
| Resource inventory | provider, account/project/subscription, region, type, identifier, status, tags |
| Logs | source, time range, query, event fields, next cursor |
| Metrics | namespace, metric, dimensions, period, statistic, datapoints |
| Billing | period, currency, service, amount, budget status |
| Security | control, severity, evidence, remediation state |

不得在公共 API 返回 `AwsLambdaFunction` 这类 provider-specific DTO；AWS 特有字段放在扩展字段中。
Azure/GCP 接入属于后续 adapter，不在 V5 第一阶段承诺完整 parity。

*Public APIs use common cloud concepts rather than provider-specific DTOs. AWS-specific fields live in
extensions. Azure/GCP are future adapters, not full parity commitments for the first V5 release.*

## 4. 图像语义搜索方案 / Image-semantic search

### 4.1 推荐数据流 / Recommended data flow

```text
processor writes redacted derivatives
        │
        ├── recognition job (async, retryable)
        │      ├── labels: object / scene / color / confidence
        │      └── embedding: optional vector representation
        │
        ├── search metadata
        └── search index

query → parser → structured filters + semantic query → result IDs → manifest/photos
```

识别任务只读取 `photos/<id>/grid.webp` 或 `view.webp` 等已脱敏产物，不读取 `incoming/` 原图。
任务必须携带 `asset_id`、content hash 和 correlation ID；重复事件由 idempotency key 去重。

*Recognition reads only redacted derivatives, never `incoming/` originals. Each task carries an asset ID,
content hash and correlation ID, and duplicate events are suppressed by an idempotency key.*

### 4.2 Provider 选型 / Provider options

| 方案 / Option | 适合 / Fit | 风险 / Risk | Plan recommendation |
|---|---|---|---|
| AWS managed vision | 物体/场景/颜色快速落地 | 按调用收费、厂商耦合、中文自然语言需额外映射 | **先做标签 vertical slice** |
| Embedding API + vector store | “湖水/山峰”等语义检索强 | 成本、隐私、embedding 生命周期 | 第二阶段评估 |
| Container model | 数据不出 AWS，可控 | 镜像大、Lambda 资源/启动时间、模型运维 | 作为隐私/成本备选 |
| 外部 API | 体验和模型能力可能强 | 数据出域、供应商合规与费用 | 默认不启用 |

推荐先实现**标签 + manifest 年月字段 + 中文 query parser**，把 embedding/vector search 留作可替换
能力。第一版可先用结构化倒排索引；当“湖水/山峰”这类查询无法达到可接受召回率时，再引入 embedding。

*Start with labels, manifest year/month and a Chinese query parser. Keep embeddings/vector search replaceable.
Introduce vectors only if structured indexing cannot provide acceptable recall for semantic queries.*

### 4.3 搜索契约 / Search contract

```json
{
  "query": "2025 年的蓝天和汽车",
  "filters": { "year": 2025 },
  "terms": ["蓝天", "汽车"],
  "page": 1,
  "pageSize": 40
}
```

返回结果只包含 manifest 中允许公开的 `id`、路径、年月、标签和排序分数；不返回原始文件名、
EXIF、GPS、模型原始响应或内部对象 key。

*Search responses contain only public manifest-safe fields and never expose original filenames, EXIF, GPS,
raw model responses or internal object keys.*

## 5. 前端方案 / Frontend plan

- 首页增加 hero section registry：每个 section 由安全的配置数据描述图片、标题、副标题和 CTA。
- 动态大图使用已存在的多档 WebP 和 `picture/srcset`；首屏只预加载当前 hero 与下一张。
- 使用 CSS scroll-driven animation / View Transitions 时必须有 capability guard；不支持时回退为静态可见。
- 搜索框支持即时建议、中文分词/同义词提示、时间条件 chip、空结果解释和基础筛选降级。
- 搜索结果继续通过 manifest 统一渲染，避免产生第二套灯箱、照片墙和 URL 状态模型。

*Use a data-driven hero registry, existing WebP derivatives, guarded motion, search suggestions and
explainable empty states. Search results reuse the manifest renderer and URL state rather than creating
a second gallery model.*

## 6. 可观测性方案 / Observability plan

### 6.1 工具选型 / Tool selection

入口不采用 CloudWatch 作为 observability system of record。AWS CloudWatch 只作为 AWS data source，
通过 collector 或 adapter 转换为跨云统一模型。

*CloudWatch is not the observability system of record. It remains an AWS data source, exposed through
collectors or adapters and normalized into a cross-cloud model.*

| 方案 / Option | 优点 / Strengths | 代价 / Trade-offs | 结论 / Decision |
|---|---|---|---|
| OpenTelemetry + Grafana OSS (Prometheus/Loki/Tempo) | 标准化 traces/metrics/logs；生态成熟；Azure/GCP 接入路径清晰 | 组件较多，需维护 storage/retention/alerting | **推荐 / Recommended** |
| SigNoz OSS + OpenTelemetry | OTel-native，一体化体验，适合原型 | ClickHouse 运维与容量规划；跨云托管形态需验证 | 原型备选 / Prototype alternative |
| OpenObserve OSS | 单体化程度高，日志/指标/trace 入口统一 | 生态、长期运维和多云 adapter 需验证 | 备选 / Alternative |
| SaaS observability | 上线快，少维护 | 非开源、数据出域和持续费用 | 本阶段不选 / Not selected |

推荐：**OpenTelemetry SDK/Java agent + OpenTelemetry Collector + Grafana OSS + Prometheus + Loki + Tempo**。
其中日志明确使用 **Grafana Loki**：Collector 接收 AWS CloudWatch、ECS Express Mode、GitHub Actions 和
未来 Azure/GCP 的日志，统一标签后写入 Loki；管理站的 Logs 页面通过 Loki/Grafana API 查询。
告警使用 Grafana Alerting；保留原始 provider adapter，后续 Azure Monitor、GCP Cloud Monitoring 通过
同一套 OTel/adapter contract 接入。Tasks 阶段验证最小部署形态和成本，避免一开始部署高可用集群。

*Recommendation: OpenTelemetry SDK/Java agent, OpenTelemetry Collector, Grafana OSS, Prometheus, Loki and
Tempo, with Grafana Alerting. Logs specifically use Grafana Loki: the Collector receives AWS CloudWatch,
ECS Express Mode, GitHub Actions and future Azure/GCP logs, normalizes labels and writes to Loki; the management
Logs page queries Loki/Grafana APIs. The Tasks stage validates a minimal deployment and cost before considering HA.*

### 6.2 数据接入 / Data ingestion

AWS 侧以 OpenTelemetry Collector、CloudWatch adapter、GitHub Actions exporter 和 AWS SDK reader
提供数据；Azure/GCP 后续以对应 adapter 提供数据。管理平台只依赖统一的 `LogProvider`、
`MetricProvider`、`TraceProvider` 和 `AlertProvider`。

*AWS data comes through OpenTelemetry Collector, a CloudWatch adapter, a GitHub Actions exporter and
AWS SDK readers. Azure/GCP will provide equivalent adapters. The management platform depends only on
provider-neutral LogProvider, MetricProvider, TraceProvider and AlertProvider ports.*

统一事件字段：

```json
{
  "event": "recognition.completed",
  "correlationId": "safe-id",
  "assetId": "hash-id",
  "stage": "recognition",
  "outcome": "success",
  "durationMs": 1820,
  "provider": "aws",
  "errorClass": null
}
```

禁止字段：phone、token、authorization、secret、originalUrl、rawExif、rawModelResponse。

### 6.3 指标与告警 / Metrics and alarms

- upload success/error rate
- processor duration and error rate
- recognition queue age, success/error rate and retry count
- DLQ depth and oldest message age
- manifest publish conflict/retry count
- CI/CD workflow failure and deployment duration
- management API latency/error rate
- AWS budget threshold and unexpected cost anomaly

告警先进入 Grafana Alerting，再按需通知 GitHub issue/comment；管理平台只聚合状态，不复制整套告警引擎。

*Alerts initially use Grafana Alerting and optionally notify GitHub issues/comments. The management site
aggregates status rather than becoming a second alerting engine.*

## 7. CI/CD 与安全治理 / CI/CD and security governance

### 7.1 分支与 PR / Branches and pull requests

- `main` 保护：禁止直接 push，要求 PR、至少一名人工 reviewer、required checks 全绿。
- GPT code review 作为 required check；失败、超时或不可用时默认阻断合并，允许显式管理员 override 并留审计记录。
- 应用仓库、infra 仓库、android 仓库分别配置 branch rules，不能用一个仓库的规则替代其他仓库。
- 合并 `main` 后触发各自既有 pipeline；management repo 使用独立 workflow，禁止跨仓库隐式写权限。

### 7.2 GPT code review 边界 / GPT review boundary

Review workflow 只读取 PR diff、相关源码和测试结果，不读取 secrets、生产日志全文、原图或 Terraform state。
其 token 只拥有读取 PR/checks 的权限；写评论使用最小 GitHub permission。

*The review workflow reads only the PR diff, relevant source and test results. It cannot read secrets, full
production logs, originals or Terraform state, and uses the minimum permission needed to publish a review.*

## 8. 基础设施变更 / Infrastructure changes

### 8.1 `album-infra`

- `20-edge`：新增独立的 `cx.chenyouyi.top` CloudFront distribution、origin、cache policy 和 certificate
  association；不得把管理站作为 `photos` distribution 的 behavior；
- `30-compute`：管理平台 ECS Express Mode、recognition queue、search index、OpenTelemetry/Grafana 相关运行资源；
- 继续使用 remote state、OIDC、layered plan 和 manual apply；
- 资源标签统一包含 `project`, `environment`, `owner`, `managed`, `cost_center`；
- 管理平台不直接拥有 `iam:*` 或 Terraform apply 权限；受控操作通过批准后的 GitHub workflow。

### 8.2 管理平台的高风险动作 / High-risk management actions

V5 第一阶段只读：inventory、logs、metrics、billing、security posture、workflow status。
后续写操作必须经过 action request、二次确认、短期凭证、allowlist、审计和可回滚 workflow。

*V5 phase one is read-only. Later write actions require an action request, explicit confirmation, short-lived
credentials, allowlists, audit records and a reversible workflow.*

## 9. 迁移顺序 / Migration order

1. **Contract first**：定义 search、management provider、observability event 和 audit DTO。
2. **Frontend shell**：hero registry、搜索入口和静态降级，不接真实识别。
3. **Recognition vertical slice**：一张脱敏图片 → 标签 → 索引 → 搜索结果；识别失败不阻塞发布。
4. **Management read-only slice**：Java health、GitHub workflow、AWS inventory、Grafana logs/metrics/traces。
5. **Management domain expansion**：security、billing、audit 和多云 adapter interfaces。
6. **Governance enforcement**：branch protection、GPT review required check、merge-to-main CI/CD。
7. **Production rollout**：先 shadow/read-only，确认成本、权限和链路后再开放任何写操作。

*The migration is contract-first, then frontend shell, recognition vertical slice, read-only management,
management domain expansion, governance enforcement and finally a shadow/read-only production rollout.*

## 10. 回滚 / Rollback

- 前端：hero/search 通过 feature flag 或入口配置关闭，旧时间轴和基础筛选保留。
- 识别：停止 queue consumer/触发器，保留已有 manifest；识别 metadata 不参与基础渲染。
- 搜索：切回 manifest 本地筛选，删除/重建索引不影响照片产物。
- 管理平台：CloudFront DNS/origin 回退；平台只读时可直接下线，不影响相册主站。
- Terraform：每层先 plan，单独 revert layer change；禁止用 root-level destroy 做回滚。
- CI/CD：旧 workflow 保留可执行版本；GPT review 不可用时按 branch policy 的显式 override 流程处理。

## 11. 成本与风险 / Cost and risks

Plan 阶段必须测量三种工作负载：每张图片一次识别、每次搜索、管理站每次日志/metrics 查询。
成本模型至少分固定成本、按调用成本、存储/索引成本和跨云数据传输成本。

*The Plan stage must measure one recognition, one search and one management logs/metrics query. The cost
model includes fixed, per-call, storage/index and cross-cloud transfer costs.*

主要风险：

| 风险 / Risk | 控制 / Control |
|---|---|
| 识别供应商锁定 / Vendor lock-in | provider port + normalized model + raw response never enters public API |
| 识别成本失控 / Recognition cost growth | async queue, quotas, cache by content hash, budget alarm |
| 管理站成为高权限单点 / Privileged control plane | read-only first, short-lived credentials, action workflow and audit |
| 多云抽象过度 / Premature multi-cloud abstraction | only abstract stable concepts; keep provider extensions |
| Apple 风格变成复制 / Style imitation | capture principles, not copyrighted assets or copied page content |
| GPT review 泄露代码/秘密 / Review data exposure | allowlisted diff context, secret scanning, minimal token permissions |

## 12. Plan 阶段验收 / Plan acceptance

- 技术选型有比较和推荐结论；
- search/management/observability contracts 已定义；
- `album`、`album-infra`、`album-android`、`album-mgmt` 的责任边界无重叠；
- 每个新增 AWS 资源有 layer、IAM owner、state、rollback 和 cost owner；
- PR/GPT review/manual approval/main CI/CD 的状态机可画出并可测试；
- 第一阶段明确为 AWS vertical slice + read-only management，Azure/GCP 只做 adapter boundary；
- 成本、隐私、数据出域和失败降级均有可验证验收项。

*Plan is accepted only when technology choices, contracts, repository boundaries, resource ownership,
governance state machine, AWS-first scope, cost, privacy and fallback criteria are all testable.*

## 13. 下一步 / Next step

Plan 确认后进入 Tasks 阶段，任务会按以下关键路径拆分：

`contracts → frontend shell → recognition vertical slice → management read-only → observability →
branch governance → production rollout`

*After Plan confirmation, Tasks will follow the critical path above.*
