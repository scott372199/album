# 个人相册 · 第五版任务清单 / Personal Album · Version 5 Tasks

> Spec-Driven Development · 阶段 3 / 5（Tasks） / Stage 3 / 5 (Tasks)
> 状态：**基础设施已部署，搜索/识别未接运行时，治理未开始** / Status: **Infrastructure deployed; search and recognition are library-only; governance not started**
> 日期 / Date: 2026-11-13（核查与校准同日 / reviewed and recalibrated the same day）
> 上游 / Upstream: [`spec.md`](./spec.md)（confirmed）+ [`plan.md`](./plan.md)（confirmed）
> 核查记录 / Review record: [`review.md`](./review.md)

本文把 V5 Plan 拆成可独立验收的任务。实现阶段不得绕过任务依赖直接修改生产资源。

*This document decomposes the confirmed V5 Plan into independently verifiable tasks. Production resources
must not be changed out of dependency order during implementation.*

**状态口径 / Status legend**（2026-11-13 校准）

| 标记 / Mark | 含义 / Meaning |
| --- | --- |
| ✅ 完成 / Done | 代码已入库且有可复现证据；**仍可能是离线库或 fixture**，以该条描述为准 |
| 🚧 进行中 / In progress | 已有一部分落地，但未达到验收标准 |
| ⏳ 未开始 / Not started | 尚无实现 |
| ⏸ 延后 / Deferred | 有意不做，理由已写明 |

⚠️ **`✅` 不等于「已达验收」**。跨仓库的最终判定只看 [`V5-ACCEPTANCE.md`](./V5-ACCEPTANCE.md)。

*`✅` means the code is committed with reproducible evidence — not that acceptance is met.
Acceptance is decided only by `V5-ACCEPTANCE.md`.*

## 1. 阶段与依赖 / Phases and dependencies

```text
P0 Contracts        T-01 → T-02 → T-03
P1 Frontend         T-04 → T-05 → T-06 → T-07
P2 Search           T-08 → T-09 → T-10 → T-11 → T-12
P3 Management       T-13 → T-14 → T-15 → T-16 → T-17
P4 Observability    T-18 → T-19 → T-20 → T-21
P5 Infrastructure   T-22 → T-23 → T-24 → T-25 → T-26
P6 Governance       T-27 → T-28 → T-29
P7 Acceptance       T-30 → T-31 → T-32
```

关键路径 / Critical path:

`T-01 → T-03 → T-05 → T-09 → T-11 → T-14 → T-19 → T-23 → T-28 → T-32`

并行工作 / Parallel work:

- T-04~T-07 前端体验与 T-13~T-17 管理站原型可在 contracts 完成后并行；
- T-18~T-21 观测栈 PoC 与 T-22~T-26 基础设施代码可并行编写，但 apply 必须按依赖顺序；
- 真实云资源变更前，必须完成对应 offline checks、plan 和安全复核。

## 2. 任务清单 / Task list

### P0 · Contracts / 契约

#### T-01 定义跨层数据契约 / Define cross-layer contracts

- **依赖 / Deps**：无 / none
- **仓库 / Repos**：`album`、`album-infra`、`album-mgmt`
- **内容 / Work**：定义 search query/result、recognition event、correlation fields、audit event、
  `LogProvider`/`MetricProvider`/`TraceProvider`/`BillingProvider` ports；明确公开字段白名单。
- **验收 / Done when**：JSON examples、Java DTO/port、Node event schema 三者字段一致；禁止字段有测试。
- **追溯 / Traces to**：FR-02、FR-03、FR-05、FR-06；Plan §3~§6。
- **状态 / Status**：✅ 完成 / Done — canonical contract JSON、服务端 contract tests、JSON/syntax checks 通过；67 项 Node tests 全绿。

#### T-02 建立 V5 目录与版本守卫 / Establish V5 layout and guards

- **依赖 / Deps**：T-01
- **仓库 / Repos**：四个仓库 / all four repositories
- **内容 / Work**：创建 `album-mgmt` 骨架约定；为 V5 新增事件、接口、配置和 provider adapter
  增加 lint/check 入口；确认 `cx` 与 `photos` 资源命名不重叠。
- **验收 / Done when**：无 secrets、原图、Terraform state；所有仓库的 check 可离线运行。
- **追溯 / Traces to**：FR-03、FR-04、FR-05、FR-06。
- **状态 / Status**：✅ 完成 / Done — `album-mgmt` skeleton check、album repo check、infra 58 项离线断言、Android 8 项自检全部通过。

#### T-03 设计权限、隐私和回滚矩阵 / Design permission, privacy and rollback matrix

- **依赖 / Deps**：T-02
- **内容 / Work**：列出管理原型各页面权限；识别数据出域边界；GPT review 最小权限；每个新资源的
  IAM owner、state、rollback、cost owner。
- **验收 / Done when**：每项高风险动作默认 read-only；安全审查能逐项映射到矩阵。
- **追溯 / Traces to**：Hard invariants、Plan §7~§10。
- **状态 / Status**：✅ 完成 / Done — `security-matrix.json`、边界测试和 CP-1 已确认。

### P1 · Frontend experience / 前端体验

#### T-04 首页 hero registry / Build the hero registry

- **依赖 / Deps**：T-01
- **仓库 / Repo**：`album`
- **内容 / Work**：增加数据驱动的顶部导航、hero sections、标题/副标题/CTA 配置；保持 manifest 单一真相。
- **验收 / Done when**：至少三个 section 可配置；无复制第三方网站文案、图片或受版权保护素材。
- **追溯 / Traces to**：FR-01。
- **状态 / Status**：✅ 完成 / Done — `site.json`/manifest 支持最多八个安全收敛的 hero sections；无配置时自动生成最多三个区块。

#### T-05 动态大图与降级 / Add dynamic imagery and fallback

- **依赖 / Deps**：T-04
- **内容 / Work**：使用现有 WebP/picture/srcset；预加载当前与下一 hero；实现 reduced-motion、
  keyboard/touch、低性能和不支持 View Transitions 的静态降级。
- **验收 / Done when**：桌面/移动端首屏无空白 hero；能力关闭时内容直接可见；不裁切照片。
- **追溯 / Traces to**：FR-01、FR-25。
- **状态 / Status**：✅ 完成 / Done — 使用 `srcset`、当前/下一图预加载、reduced-motion 与低性能静态降级，保持 `object-fit: contain`。

#### T-06 搜索入口与结果体验 / Add search UX

- **依赖 / Deps**：T-05、T-01
- **内容 / Work**：搜索框、建议、时间 chip、空结果解释、加载/错误状态；复用现有 URL state、
  manifest renderer、灯箱和照片墙。
- **验收 / Done when**：`湖水`、`2025 年`等查询有明确状态；搜索服务失败时基础筛选仍可用。
- **追溯 / Traces to**：FR-02、FR-01。
- **状态 / Status**：✅ 完成 / Done — added search suggestions, year chips, explainable empty/loading/error states, URL-preserving local fallback, and natural-language year matching; tests and offline checks pass.

#### T-07 前端性能与可访问性验证 / Validate frontend performance and accessibility

- **依赖 / Deps**：T-06
- **内容 / Work**：测量首屏、hero 切换、搜索交互、键盘焦点、对比度、reduced-motion 和 Android WebView。
- **验收 / Done when**：指标阈值在测试记录中固定；`npm test`、`npm run verify`、`npm run check:repo` 通过。
- **追溯 / Traces to**：FR-01、Plan §5。
- **状态 / Status**：✅ 完成 / Done — thresholds and browser/static accessibility evidence are recorded in [`validation.md`](./validation.md); build, browser smoke checks, tests, verify, and repository checks pass. Real-device Android timing remains an environment limitation.

### P2 · Semantic search / 图像语义搜索

#### T-08 脱敏派生图识别输入 / Define redacted recognition input

- **依赖 / Deps**：T-03
- **仓库 / Repo**：`album`
- **内容 / Work**：选择 `grid.webp`/`view.webp` 输入；禁止 `incoming/`；建立 content hash/idempotency key；
  记录 recognition event。
- **验收 / Done when**：测试能证明原图不会进入识别调用；重复事件只产生一次任务。
- **追溯 / Traces to**：FR-02、FR-25。
- **状态 / Status**：✅ 完成 / Done — 边界校验已入库并有测试（拒绝 `incoming/` 与非识别资产、确定性 idempotency key），但**尚无任何调用方**。 *Boundary validation is committed and tested; it has no caller yet.*
#### T-09 结构化标签识别 worker / Build the structured-label worker

- **依赖 / Deps**：T-08
- **内容 / Work**：异步 queue consumer；输出 object/scene/color/confidence；失败可重试、入 DLQ，
  不阻塞 processor 发布。
- **验收 / Done when**：一张脱敏测试图完成识别；坏输入/供应商失败可见且照片仍上线。
- **追溯 / Traces to**：FR-02、Plan §4。
- **状态 / Status**：🚧 进行中 / In progress — 已完成注入式 worker 边界、结构化标签、幂等去重、重试与 DLQ 语义、供应商输出校验；**缺 SQS 队列、Lambda 入口与镜像内 provider**，因此「一张脱敏图完成识别」尚未真实发生过。 *Worker boundary done; queue, Lambda entry and a real provider are missing.*
#### T-10 中文 query parser / Build the Chinese query parser

- **依赖 / Deps**：T-01、T-09
- **内容 / Work**：解析物体、场景、颜色、同义词和年份；生成结构化 filters/terms；不把原始模型响应暴露给前端。
- **验收 / Done when**：覆盖“湖水、山峰、蓝天、汽车、摩托车、红色衬衫、2025 年”测试用例。
- **追溯 / Traces to**：FR-02、Plan §4.3。
- **状态 / Status**：✅ 完成 / Done — added structured Chinese query parsing for objects, scenes, colors, synonyms, year/month filters, pagination validation, and raw-response exclusion; tests cover all agreed examples.

#### T-11 搜索索引与 API / Build the search index and API

- **依赖 / Deps**：T-09、T-10
- **内容 / Work**：实现结构化倒排索引、分页、排序和 manifest-safe result；为 embedding 保留 adapter port，
  本任务不强制引入 vector database。
- **验收 / Done when**：重复处理不重复索引；结果只含公开字段；索引不可用时基础筛选可用。
- **追溯 / Traces to**：FR-02、Hard invariants。
- **状态 / Status**：🚧 进行中 / In progress — 已完成结构化倒排索引、manifest-safe 分页 facade、确定性排序、重复 upsert 与 embedding port；**索引只在内存、无 HTTP 路由、无持久化**。 *Index and facade exist in memory; no route, no persistence.*
#### T-12 搜索端到端验收 / Verify semantic search end to end

- **依赖 / Deps**：T-11、T-06
- **内容 / Work**：上传/处理一张测试图 → 识别 → 索引 → 查询 → 进入灯箱；验证失败降级。
- **验收 / Done when**：成功、重复、识别失败、索引不可用四条路径都有证据。
- **追溯 / Traces to**：FR-02、Plan §9。
- **状态 / Status**：🚧 进行中 / In progress — 离线链路测试已覆盖成功、重复、识别失败、索引不可用四条路径，但用的是测试替身，**真实照片尚未跑过**。 *Offline slice covered with test doubles; no real photo has traversed it.*
### P3 · `album-mgmt` Java prototype / Java 管理站原型

#### T-13 创建 `album-mgmt` 工程 / Create the management repository

- **依赖 / Deps**：T-02
- **仓库 / Repo**：新建 `album-mgmt`
- **内容 / Work**：Java 21 LTS、Spring Boot、Gradle Kotlin DSL、模块化目录、React/Vite frontend、
  formatter/linter/test/build、Dockerfile；原型阶段不引入数据库，使用 mock/fixture。
- **验收 / Done when**：clean checkout 可 build/test；没有云密钥；健康页可运行。
- **追溯 / Traces to**：FR-03、Plan §2。
- **状态 / Status**：✅ 完成 / Done — added the Java 21 Spring Boot Gradle application module, React/Vite shell, read-only health endpoint, Dockerfile, offline safety check, Tencent Maven mirror fallback, and reproducible Gradle wrapper; Java tests, frontend build, safety check, and health smoke test pass.

#### T-14 管理站原型 UI / Build the prototype UI

- **依赖 / Deps**：T-13
- **内容 / Work**：导航和只读页面：CI/CD、resources、logs、metrics、security、billing、audit；
  使用 mock/fixture 数据，清楚标记数据来源与 unavailable 状态。
- **验收 / Done when**：用户能从首页进入所有模块；移动/桌面布局可用；不提供高风险写按钮。
- **追溯 / Traces to**：FR-03、Plan §3.1。
- **状态 / Status**：✅ 完成 / Done — added hash-routed read-only module details for all seven areas, explicit fixture/unavailable states, responsive tables, and no write controls; browser smoke-tested CI/CD and Logs navigation.

#### T-15 AWS/GitHub read adapters / Build read-only adapters

- **依赖 / Deps**：T-13、T-14
- **内容 / Work**：GitHub workflow/PR adapter；AWS inventory adapter；provider-neutral DTO；
  secrets/role metadata 只返回安全摘要。
- **验收 / Done when**：mock 与真实 adapter 可切换；公共 API 不出现 vendor-specific DTO。
- **状态 / Status**：✅ 完成 / Done — added the provider-neutral read port, fixture adapter, safe resource/workflow DTOs, AWS ECS/ECR/CloudFront read adapter, GitHub Actions REST adapter, and profile-based switching; public API exposes no vendor-specific DTOs.
- **追溯 / Traces to**：FR-03、Plan §3.2。

#### T-16 认证、RBAC 和审计 / Add identity, RBAC and audit

- **依赖 / Deps**：T-03、T-15
- **内容 / Work**：Spring Security；管理员身份；最小角色；所有读取记录 audit event；
  token/secret/手机号不写日志。
- **验收 / Done when**：未授权访问被拒；页面权限有测试；审计记录带 correlation ID。
- **追溯 / Traces to**：FR-03、FR-05、Hard invariants。
- **状态 / Status**：🚧 延后 / Deferred — current `cx.chenyouyi.top` remains public read-only by design; correlation IDs and safe read audit events are active. When write APIs are introduced, authentication will reuse the album upload phone allowlist + scrypt shared-key + token flow instead of adding a second password system.

#### T-17 管理站原型发布 / Deploy the management prototype

- **依赖 / Deps**：T-16、T-21、T-26
- **内容 / Work**：ECS Express Mode image、health check、CloudFront origin、TLS/redirect、独立域名；
  先 shadow/read-only。
- **验收 / Done when**：`https://cx.chenyouyi.top` 可访问；`photos` distribution 和站点行为无变化。
- **追溯 / Traces to**：FR-03、Plan §2.3、§8。
- **状态 / Status**：✅ 完成 / Done — `cx` 已可访问（`/actuator/health` 返回 200），DNS 指向独立分发 `EX15BSO66B05G`；`photos` 分发与站点行为未改动。 *Live and reachable; the photos distribution is untouched.*

### P4 · Open-source observability / 开源可观测性

#### T-18 OpenTelemetry instrumentation / Add OpenTelemetry instrumentation

- **依赖 / Deps**：T-01、T-03
- **仓库 / Repos**：`album`、`album-mgmt`
- **内容 / Work**：统一 correlation ID、logs/metrics/traces 字段；Java agent/SDK；Node event bridge；
  secret fields denylist。
- **验收 / Done when**：一次上传、处理、识别、管理 API 请求可产生同一 correlation chain。
- **追溯 / Traces to**：FR-05、Plan §6。
- **状态 / Status**：🚧 进行中 / In progress — management API now emits bounded correlation IDs and safe read audit events, exposes Actuator metrics/Prometheus endpoints, and includes a Micrometer-to-OpenTelemetry bridge with sampling disabled by default; collector wiring remains deployment work.

#### T-19 Grafana/Loki/Prometheus/Tempo PoC / Build the observability PoC

- **依赖 / Deps**：T-18
- **仓库 / Repo**：`album-infra`
- **内容 / Work**：OpenTelemetry Collector、Grafana OSS、Loki logs、Prometheus metrics、Tempo traces；
  固定 retention；最小非 HA 部署。
- **验收 / Done when**：logs、metrics、traces 各有一条可查询测试数据；组件不读生产 secrets。
- **追溯 / Traces to**：FR-05、Plan §6.1。
- **状态 / Status**：🚧 进行中 / In progress — added a local, non-HA Docker Compose PoC with OpenTelemetry Collector, Grafana, Loki, Prometheus and Tempo; fixed seven-day retention and no production secret access. Signal generation/query smoke test requires a container runtime.

#### T-20 AWS/GitHub collectors / Connect AWS and GitHub data

- **依赖 / Deps**：T-19
- **内容 / Work**：CloudWatch/ECS Express Mode/GitHub Actions data adapters；标准 labels；provider 字段；
  未来 Azure/GCP adapter interface。
- **验收 / Done when**：不直接把 CloudWatch API 暴露给 UI；Grafana/Loki 查询可返回安全数据。
- **追溯 / Traces to**：FR-04、FR-05。
- **状态 / Status**：🚧 进行中 / In progress — the provider-neutral management adapter boundary is in place; the local observability stack now applies stable service/environment resource labels, while live CloudWatch/GitHub credentials remain intentionally unconfigured.

#### T-21 dashboards and alerts / Add dashboards and alerts

- **依赖 / Deps**：T-20
- **内容 / Work**：上传、processor、recognition、DLQ、CI/CD、management API、cost anomaly dashboards；
  Grafana Alerting 和通知路径。
- **验收 / Done when**：人为制造一条失败能触发可定位告警；告警不含 token/原图/手机号。
- **追溯 / Traces to**：FR-05、Plan §6.3。
- **状态 / Status**：🚧 进行中 / In progress — added a read-only Grafana management API dashboard for request rate, p95 latency and 5xx rate; alert routing and production notification channels remain deployment work.

### P5 · Independent infrastructure / 独立基础设施

#### T-22 `album-infra` resource design / 设计管理站资源

- **依赖 / Deps**：T-03
- **仓库 / Repo**：`album-infra`
- **内容 / Work**：独立 `cx` CloudFront distribution、ACM data/import strategy、ECS Express Mode、observability
  resources、recognition queue/index；与 photos distribution 完全分离。
- **验收 / Done when**：每项资源有 layer、owner、IAM、state key、rollback 和 cost owner。
- **追溯 / Traces to**：FR-04、Plan §8。
- **状态 / Status**：✅ 完成 / Done — added the management resource ownership matrix covering layer, owner/cost owner, IAM boundary, state key and rollback gate; management edge remains isolated from the photos distribution.

#### T-23 Terraform modules and IAM / 编写模块与最小权限

- **依赖 / Deps**：T-22
- **内容 / Work**：ECS Express/container module、management CDN thin module、recognition queue、
  observability storage/retention、read-only management role；禁止 `iam:*` 和直接 apply。
- **验收 / Done when**：fmt/validate/offline checks 通过；无环境字面量和长期密钥。
- **追溯 / Traces to**：FR-04、FR-05。
- **状态 / Status**：✅ 完成 / Done — added the native Terraform ECS Express service, immutable management ECR repository, task-execution and ECS infrastructure roles, CloudWatch logs, CPU scaling, and an explicit image/enable gate; offline checks, format, validation and least-privilege review pass.
- **补充 / Note**：manual infrastructure apply now honors the selected layer input instead of always applying every layer; apply remains OIDC-backed, serial and double-confirmed.

#### T-24 Independent CloudFront and TLS / 创建独立分发与 TLS

- **依赖 / Deps**：T-23
- **内容 / Work**：CloudFront edge TLS termination、ACM、HTTP→HTTPS、HTTPS ECS Express origin、
  独立 cache/invalidation。
- **验收 / Done when**：`cx` 与 `photos` 分发互不影响；直连 origin 不作为公开入口；TLS boundary 有证据。
- **追溯 / Traces to**：FR-03、Plan §2.3。
- **状态 / Status**：✅ 完成 / Done — added the independent `40-management-edge` layer with an ECS Express custom origin, us-east-1 ACM lookup, HTTPS-only origin policy, disabled caching for management responses, and a separate CloudFront state; DNS cutover remains explicitly gated on T-25 runtime health.

#### T-25 ECS Express Mode and observability apply / 部署运行时与观测栈

- **依赖 / Deps**：T-21、T-24
- **内容 / Work**：先 plan，再人工确认 apply；部署 ECS Express Mode prototype 与最小观测栈；
  设置 retention、budget 和 rollback。
- **验收 / Done when**：health/read API、Grafana/Loki/Prometheus/Tempo 查询和 rollback 全通过。
- **追溯 / Traces to**：FR-03、FR-05、Plan §8~§10。
- **状态 / Status**：✅ 完成 / Done — ECS Express `album-mgmt` is ACTIVE and steady-state with one running task; `/actuator/health` and `/api/management/snapshot` return HTTP 200; CloudFront edge is deployed with HTTPS-only origin, TLS 1.2+, disabled caching, and read-only methods. DNS traffic cutover remains intentionally manual.

#### T-26 Cost and security verification / 成本与安全验证

- **依赖 / Deps**：T-25
- **内容 / Work**：测量 ECS Express、CloudFront、观测栈存储/流量、识别和查询成本；检查 public exposure、
  IAM、TLS、retention 和数据出域。
- **验收 / Done when**：成本模型有固定/变量项；所有超预算或高风险项有明确 gate。
- **追溯 / Traces to**：FR-03、FR-05、Plan §11。
- **状态 / Status**：✅ 完成 / Done — verified runtime IAM, security-group ingress, TLS, CloudFront methods, 14-day log retention, and regional service cost data; the remaining DNS traffic cutover is intentionally outside this task and remains a manual release gate.

### P6 · Branch governance / 分支与交付治理

#### T-27 Branch protection / 配置分支保护

- **依赖 / Deps**：T-02、T-03
- **内容 / Work**：四个仓库的 protected main、禁止直接 push、required checks、人工 reviewer、
  CODEOWNERS/环境保护。
- **验收 / Done when**：无审批 PR 无法合并；规则不会意外授予 fork PR 云权限。
- **追溯 / Traces to**：FR-06、Plan §7。
- **状态 / Status**：⏳ 未开始 / Not started — 四个仓库均无分支保护与 required checks。 *No branch protection or required checks anywhere.*

#### T-28 GPT code review / 接入 GPT code review

- **依赖 / Deps**：T-27
- **内容 / Work**：只读取 PR diff/相关测试；最小 GitHub permission；作为 required check；
  timeout/failure 默认阻断，管理员 override 留审计。
- **验收 / Done when**：真实测试 PR 有 review/check；secret、原图、state 不会进入 review context。
- **追溯 / Traces to**：FR-06、Plan §7.2。
- **状态 / Status**：⏳ 未开始 / Not started — 无 review workflow，也无 required check。 *No review workflow, no required check.*

#### T-29 Merge-to-main CI/CD / 验证合并后流水线

- **依赖 / Deps**：T-28
- **内容 / Work**：`album-mgmt` build/test/image/deploy；album/infra/android 的 existing workflow
  保持边界；失败保留 last-known-good。
- **验收 / Done when**：成功 merge 触发正确 pipeline；故意失败不会破坏线上版本。
- **追溯 / Traces to**：FR-06、Plan §7。
- **状态 / Status**：⏳ 未开始 / Not started — `album-mgmt` 只有 `container.yml`（构建 + 推 ECR）；ECS 部署仍靠 `album-infra` 手动 apply。 *Only an image build workflow exists; deployment is a manual infra apply.*

### P7 · Acceptance / 总体验收

#### T-30 Cross-repository integration / 跨仓库联调

- **依赖 / Deps**：T-07、T-12、T-17、T-21、T-25、T-29
- **内容 / Work**：验证 frontend → search → management read model → observability → GitHub CI/CD 全链路。
- **验收 / Done when**：成功路径、识别失败、搜索不可用、管理站不可用、观测栈不可用均有降级。
- **追溯 / Traces to**：V5 全部 FR。
- **状态 / Status**：⏳ 未开始 / Not started — 前置 T-12、T-21、T-29 未达验收。 *Blocked by T-12, T-21 and T-29.*

#### T-31 Security and privacy acceptance / 安全与隐私验收

- **依赖 / Deps**：T-30
- **内容 / Work**：扫描 logs/metrics/search/index/management API；验证无 EXIF/GPS/原图/secret；
  验证 RBAC、TLS、branch policy、OIDC、无长期密钥。
- **验收 / Done when**：所有 hard invariants 有证据；不合格项阻断发布。
- **追溯 / Traces to**：Hard invariants、FR-05、FR-06。
- **状态 / Status**：⏳ 未开始 / Not started — 部分隔离项已被 `docs/03-security.md` §11 自检覆盖（含管理站只读与敏感字段扫描）。 *Partially covered by the docs pre-flight list.*

#### T-32 V5 release gate / V5 发布关卡

- **依赖 / Deps**：T-31
- **内容 / Work**：记录性能、成本、告警、回滚、用户原型反馈和已知限制；确认是否扩大管理站权限或引入 embedding。
- **验收 / Done when**：Spec/Plan/Tasks 交付记录完整；下一轮范围不与 V5 混写。
- **追溯 / Traces to**：Plan §12。
- **状态 / Status**：⏳ 未开始 / Not started — 仍受 `V5-ACCEPTANCE.md` 的 5 条 release blocker 约束。 *Still gated by five release blockers.*

## 3. 用户检查点 / User checkpoints

| Checkpoint | 时点 / When | 需要确认 / Confirmation |
|---|---|---|
| CP-1 | T-03 | 契约、权限、隐私与回滚矩阵 |
| CP-2 | T-12 | 语义搜索 vertical slice 与降级路径 |
| CP-3 | T-17 | Java 管理站原型 UI 与只读范围 |
| CP-4 | T-21 | Loki/Prometheus/Tempo 最小观测栈 |
| CP-5 | T-24 | `cx` 独立 CloudFront/TLS 与 photos 隔离 |
| CP-6 | T-29 | branch protection、GPT review、CI/CD 状态机 |
| CP-7 | T-32 | V5 总体验收与下一阶段范围 |

## 4. 明确不做 / Explicitly out of scope

1. 管理站第一阶段直接 apply Terraform、删除资源、修改 IAM 或写入生产配置；
2. 识别原图、EXIF/GPS 或把原图发送给第三方；
3. 第一阶段完整 Azure/GCP 资源控制面；
4. 一开始部署 Kubernetes 或高可用 observability cluster；
5. 第一阶段强制引入 embedding/vector database；
6. 用复制 Apple 素材、页面文案或受版权保护资源实现视觉效果。
