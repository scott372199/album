# V5 实现决策基线 / V5 Implementation Baseline

> 日期 / Date: 2026-11-13
> 状态 / Status: **已确认，作为重新编码的唯一依据** / Confirmed; sole basis for the rebuild
> 上游 / Upstream: [`spec.md`](./spec.md)、[`plan.md`](./plan.md)、[`tasks.md`](./tasks.md)

用户已明确：V5 是全新迭代，**允许生产中断、允许重新部署、允许废弃半成品**。
本轮不修补旧实现，按 spec/plan 重新编码。以下八项由用户逐项确认，冲突处以此表为准。

*The user confirmed V5 is a clean iteration: production interruption, redeployment and
discarding the partial implementation are all acceptable. This round rebuilds from the spec
instead of patching. Where documents conflict, this table wins.*

## 1. 决策表 / Decision table

| # | 决策 / Decision | 结论 / Adopted |
|---|---|---|
| D-1 | 代码基线 / Code baseline | 回到 v4 关闭点（`album@ef78dce`、`album-infra@f7776bf`），丢弃 V5 半成品代码与本地提交；保留 v4 上传/转码/脱敏链路与 Android 壳 |
| D-2 | 识别 provider / Recognition | AWS Rekognition `DetectLabels` + `Image Properties`；仅脱敏派生图入参，数据不出 AWS |
| D-3 | 成本与启停 / Cost | 成品优先；ECS 按需开启，关闭时销毁运行时但保留数据；全开约 ¥725/月，全关趋近 ¥15/月 |
| D-4 | 身份 / Identity | 登录 + RBAC + 审计；共享 `/album/auth/phones` 白名单与 scrypt 校验，独立 `/album/mgmt/jwt_secret` |
| D-5 | 索引 / Index | S3 静态 `data/search-index.<rev>.json`，前端直接拉取；embedding 仅保留 adapter port |
| D-6 | IaC 组织 / IaC layout | 按站点切分：`00-account/` + `sites/photos/{四层}` + `sites/management/{四层}`，各层独立 state，站点间互不依赖 |
| D-7 | 观测栈 / Observability | ECS Fargate 单 task 多容器（OTel Collector / Prometheus / Loki / Tempo / Grafana）+ EFS；随 `mgmt_enabled` 一起拉起与销毁 |
| D-8 | 治理 / Governance | PR 前 Copilot check run + 人工 approval 均为 required；合并 main 后触发部署；失败保留 last-known-good |

## 2. 与 spec/plan 的偏差登记 / Deviations

| 条目 / Item | 原文 / Original | 偏差 / Deviation | 理由 / Rationale |
|---|---|---|---|
| FR-04 | 「继续使用 `album-infra` 的四层边界」 | 改为「共享账号层 + 每站点各四层」 | 用户确认 photos 与 cx 是互不依赖的独立站点，按站点切分比按技术层切分更彻底地隔离 |
| §2.3 | 管理站用 ECS Express Mode | 管理站仍用 ECS Express；**观测栈另用 ECS Fargate 多容器** | Grafana 栈是 5 个有状态进程，ECS Express 面向单主容器 Web 应用 |
| §6 成本 | 总体 ≤ ¥15/月 | 全开约 ¥725/月，靠按需开关把「大部分时间」压回 ¥15 量级 | 用户明确要求先看到成品效果，并接受按需启停 |
| §8.1 | 新增资源归入 `20-edge` / `30-compute` | 归入 `sites/management/` 对应层 | D-6 的直接结果 |
| §3.1 | 未来用 PostgreSQL FTS + pgvector | 本轮不引入数据库，用 S3 静态索引 | D-5；避免常驻 RDS 与 NAT 成本 |

## 3. 硬性不变量（不变）/ Hard invariants, unchanged

1. 公开产物不含 GPS、设备序列号、原始文件名、具体拍摄时刻。
   *No GPS, device serial, original filename or exact capture time in public artifacts.*
2. 识别失败不阻塞照片上线；转码/脱敏失败不生成坏清单条目。
   *Recognition failure never blocks publication.*
3. 每个新写路径有明确 prefix ownership、IAM owner 与失败落点。
   *Every write path has prefix ownership, an IAM owner and a failure sink.*
4. 日志与指标不含凭证、令牌、手机号、原图内容。
   *No credentials, tokens, phone numbers or original image content in logs/metrics.*
5. 兼容 Android bridge、APK 更新链与 WebView 降级。
   *Android bridge, APK update flow and WebView fallback stay compatible.*

## 4. 交付顺序 / Delivery order

`契约 → 前端 → 搜索链路 → Java 管理站 → 观测栈 → 按站点 IaC → 本地成品演示 → PR 治理 → 线上按需开启`

*Contracts → frontend → search → Java management → observability → site-split IaC → local demo →
PR governance → on-demand production rollout.*

本地演示优先：先交付零云费用、可交互的成品；用户确认效果后再 apply 到 `cx.chenyouyi.top`，
演示结束立即执行关闭开关。

*The local demo comes first at zero cloud cost. Production is applied only after the user
approves the result, and the off switch runs right after the demo.*
