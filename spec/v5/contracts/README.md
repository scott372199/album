# V5 契约说明 / V5 Contract Notes

`v5-contracts.json` 是重新编码时**唯一的机器可读契约**；决策依据在
[`../DECISIONS.md`](../DECISIONS.md)，目标与边界在 [`../spec.md`](../spec.md)。

*`v5-contracts.json` is the single machine-readable contract for the rebuild. Decisions live in
`DECISIONS.md`; goals and boundaries live in `spec.md`.*

## 必须遵守 / Mandatory

| 主题 / Topic | 规则 / Rule |
|---|---|
| correlation ID | `corr_[0-9a-f]{16}`，从 `X-Correlation-Id` 读入（合法才用），贯穿上传 → 处理 → 识别 → 索引 → 失效 → CI/CD → 管理站 |
| 公开字段 / Public fields | 只用 `publicFields` 白名单；`forbiddenFields` 里的字段在任何产物、日志、指标、API 响应中都不允许出现 |
| 识别输入 / Recognition input | `sourceAsset` 必须匹配 `^photos/[a-f0-9]{12}/(grid\|view)\.webp$`；`incoming/` 原图一律拒绝 |
| 索引 / Index | 只写 `data/search-index.<rev>.json`；条目 id 必须存在于当前 manifest；重复 id 拒绝；索引缺失时降级为 manifest 本地筛选 |
| 管理站 API / Management API | `/api/v1/*`，统一 `commonEnvelope`；公共响应**不得**出现 vendor-specific DTO 或完整 ARN |
| 权限 / RBAC | 每个域一个 `<domain>:read` 权限，逐域校验；每次读取写 audit event |
| 身份 / Identity | 共享 `/album/auth/phones` 与 scrypt 校验，独立 `/album/mgmt/jwt_secret`；两边令牌互不通用 |
| IaC / Infrastructure | `00-account/` 共享；`sites/photos` 与 `sites/management` 各四层、独立 state、互不依赖 |
| 治理 / Governance | Copilot check run + 人工 approval 均为 required；Copilot approval **不计入**合并要求 |

## 写路径归属 / Prefix ownership

发布流水线只写 `assets/` 和 `index.html`；processor 只写 `photos/` 与 `data/manifest.*`、
`data/version.json`；索引发布器只写 `data/search-index.*.json`；APK 由本机脚本写 `apk/`；
Terraform 不管理任何内容对象。

*Deploy writes `assets/` + `index.html`; the processor writes photos and manifests; the index
publisher writes only the index; APKs come from a local script; Terraform manages no content.*

## 失败降级 / Degradation

1. Rekognition 超时/限流/不可用 → 照片仍按 v4 流程上线，索引条目标记 `source: manifest`。
   *Recognition outage never blocks publication.*
2. 索引对象缺失或版本落后 → 前端只用 manifest 的年份/月份/标签筛选。
   *A missing index falls back to manifest-only filtering.*
3. 管理站某域 adapter 不可用 → 返回 `source: unavailable` 与明确原因，不伪造数据。
   *An unavailable adapter reports `unavailable`; it never fabricates data.*
4. 观测栈未启动 → 结构化日志仍写 CloudWatch，指标不丢。
   *Structured logs still go to CloudWatch when the Grafana stack is off.*
