# V5 全矩阵验收执行计划 / V5 Full-Matrix Acceptance Plan

> 2026-11-14。用户选定「按 `V5-ACCEPTANCE.md` 全矩阵验收」，即不缩范围、不降口径。
> 本文是执行顺序与决策记录，不替代验收矩阵；判定仍只看 `V5-ACCEPTANCE.md`。
> **当前状态：已按用户授权点火成功**：管理站四层在线（`30-compute` 26 个资源 +
> 常驻 CloudFront 分发 `E2VQ7PHXOKOIVY`），`/actuator/health` 返回 `UP`。
> 等待用户把 CNAME 指向 `d7shs93wdjmbm.cloudfront.net` 后开始逐域验收；
> 验收后再一键销毁。判定仍只看 `V5-ACCEPTANCE.md`，代码就绪与站点上线都不等于验收通过。
>
> *On 2026-11-14 the user chose full-matrix acceptance. This is the execution order
> and decision record; the acceptance matrix remains the only gate. **The site has now
> been brought up with the user's authorisation**: all four management layers are live
> (26 resources in 30-compute plus the persistent CloudFront distribution
> `E2VQ7PHXOKOIVY`), and `/actuator/health` returns `UP`. Domain-by-domain acceptance
> starts once the user points the CNAME at `d7shs93wdjmbm.cloudfront.net`; one-click
> teardown follows acceptance. Code readiness and a live site are not acceptance.*

## 1. 目标 / Goal

真实运维数据、6 个 release blockers 拿到生产证据、T-29~T-32 完成、
`Required acceptance commands`（含 3 条 `cx.chenyouyi.top`）全部跑通，最后出验收记录交用户签字。

*Real operational data, evidence for all 6 blockers, T-29~T-32 closed, all required
commands passing, then a signed acceptance record.*

## 2. 现状盘点 / Current state (2026-11-14)

| 项 / Item | 事实 / Fact |
| --- | --- |
| 管理站分发 / Management distribution | `EX15BSO66B05G` 已不存在（`NoSuchDistribution`），需由 `20-edge` 新建 / gone; `20-edge` must create a new one |
| DNS | `cx.chenyouyi.top` → `d3ordflcyau05c.cloudfront.net.`（悬空 CNAME）；Route53 无 hosted zone，域名在外部服务商 / stale CNAME; DNS is external, no Route53 zone |
| 证书 / Certificate | `cx.chenyouyi.top` 在 us-east-1 仍 `ISSUED`，按用户偏好保留复用 / still ISSUED, reused |
| 存储 / Storage | `chenyouyi-mgmt-data` 桶 404，需 `10-storage` 创建 / missing; `10-storage` creates it |
| State | `chenyouyi-tfstate` 下 `management/` 四层全空，四层都从零 apply / all four management states empty |
| 镜像 / Image | ECR `album-mgmt` 最新 `sha256:366e16939127214f8170365f888b1fcdfff611736c93fef1fb3fc7145edac47d`（`sha-eb4e3e8…`），可复用 / reusable |
| 密钥 / Secrets | GitHub 仅 3 个 secret，缺 `MGMT_GRAFANA_ADMIN_PASSWORD`（`mgmt_enabled=true` 要求 ≥16 字符）/ missing Grafana secret |
| IAM | `30-compute` 只有 `execution_role` 与 `infrastructure_role`，**无 task role**；容器当前无任何 AWS 权限 / no task role today |
| 管理站代码 / mgmt code | 已有 `Aws*ReadAdapter`、`GitHubActionsReadAdapter`、`CloudAdaptersConfig` 骨架，但 `@Profile("cloud")` 下 `AwsSdkClients(null,null,null)` 是空壳；`FixtureData.java` 仍有 `planned` 字面量 / adapters are skeletons; fixture still reports `planned` |
| photos 站 / Photo site | 稳定：镜像 `cdcb62184866`、索引 `rev=72fbe1c4c299…`（47 条 / 34 识别）、九层 plan 全绿 / stable, all nine plans green |

## 3. 已定决策 / Decisions made

**D-A · #3 要真实运维数据，不要降级 / Real operational data, no fallback**

用户原话「我做 mgmt 站点，当然是要读取真实的数据，要真实的运维」。
用大白话说明被否决的那条路径：*「经批准的运维降级」＝ 管理站理直气壮地显示「暂无数据」，
并由用户签字认可*。矩阵原文允许它，但用户不要。因此 Logs / Metrics / Billing / Resources /
CI-CD 六域都要接真实、权限受限的只读数据源。

*The rejected option, in plain words: an "approved operational fallback" means the
management site openly says "data unavailable" and the user signs off on it. The
matrix allows it, but the user wants real data. All six domains need real,
permission-scoped read sources.*

**D-B · 真实适配器的技术路线 / Technical route for real adapters**

`CloudAdaptersConfig` 的注释本就要求「生产由 IaC 提供带只读 task role 的 client」，补齐属于
完成设计。为避免与「无长期密钥」硬约束冲突，**管理站不直连 GitHub**：CI 把 workflow 状态
写成 S3 里的只读快照，管理站只读 AWS 数据源。需要：

- `30-compute` 新增最小权限 task role：CloudWatch Logs / Metrics 只读、Cost Explorer 只读、
  资源 describe 只读、站点只读快照 S3 的 `GetObject`；
- `AwsSdkClients` 注入真实 client；`SPRING_PROFILES_ACTIVE=cloud`；六域返回真实数据；
- `FixtureData` 的 `planned` 改为 `unknown` 或由真实只读清单替换（blocker #6）；
- T-31 重新做安全与隐私评审，确认没有 EXIF / GPS / 原图 / 密钥泄漏。

*The management site never talks to GitHub directly: CI writes a read-only workflow
snapshot to S3, so only AWS permissions are needed and no long-lived token is
introduced. A least-privilege task role, real SDK clients, the `cloud` profile, the
`planned` → `unknown` fix and a fresh T-31 security review are required.*

**D-C · 一键拉起 / 一键销毁，代码就绪后再点火 / One-click up / down, ignite only when code is ready**

用户原话「代码就绪后，拉起服务我来验收。验收后我们再安排销毁环境。要有能一键拉起，
一键销毁的能力」。因此：

- 顺序改为**先写完代码、不 apply** → 用户发话 → 一键拉起 → 用户验收 → 一键销毁；
- `mgmt-lifecycle.yml` 提供 `action=up|down` + 二次确认的一次触发入口；
- `up` 按 00-bootstrap → 10-storage → 30-compute → 20-edge 顺序 apply；
  `down` 只 apply 20-edge → 30-compute 关站，保留 ECR、数据桶、state 与证书；
- 开关用 `-var mgmt_enabled=…` 覆盖，不改 `prod.tfvars` 落盘。**已知且被接受的张力**：
  up 期间 CI 的 plan（不带覆盖变量）会显示 management 层有 diff，这是「环境还开着」的
  正确提醒，plan 有变更不算 failure，九层仍全绿；
- `down` = 关站，不是彻底拆除。彻底删除 ECR / 桶 / state / 证书需另行确认；
- 预算告警不设为前置阻断，但仍在 T-32 记录成本与关站纪律。

*Code first, no apply. One manual trigger brings the site up in dependency order;
one brings it down. Down means switched off — ECR, the data bucket, state and the
certificate survive. Full teardown is a separate approval.*

**D-D · #1 六示例延至 V6 / Six examples deferred to V6**

用户明确「留到 V6 再优化」。`摩托车`、`红色衬衫` 在库里没有对应内容，属语料事实。
V5 内 #1 仅保留「脱敏派生图产出识别标签 + 可解释查询」这部分证据，
六示例全命中作为**用户批准的例外**记入 T-32 发布关卡与验收记录，并追加到 V6 backlog。

*Only the redacted-derivative + explainable-query half of #1 is evidenced in V5;
full six-example coverage is a user-approved exception recorded at the T-32 gate
and carried into the V6 backlog.*

**D-E · DNS cutover 是用户操作 / User action**

新 `20-edge` 产出新 CloudFront 域名；Route53 无 zone，CNAME 必须由用户在外部服务商修改。
验收命令里的 `cx.chenyouyi.top` 在此之前不可能返回 200。

*A new distribution produces a new domain; the user updates the CNAME at the
external registrar before any `cx.chenyouyi.top` check can pass.*

## 4. 阶段 / Phased plan

| 阶段 / Phase | 动作 / Work | 仓库 / Repos | 用户确认点 / Gate |
| --- | --- | --- | --- |
| P0 | 决策拍板（已完成）、现状盘点、本计划 | — | ✅ 已定 / decided |
| **P0.5** | **一键能力**：`mgmt-lifecycle.yml`（up/down + 二次确认 + 依赖顺序 + 前置校验）；离线验证，不触发 | album-infra | PR 审阅合并 |
| P1-code | 真实适配器接线、最小权限 task role、CI 快照、`planned` → `unknown`、#4 `corr_…` 贯穿、#2/#5 证据代码 | album-mgmt + album-infra + 个人相册 | 每仓 PR，**均不 apply** / PRs only |
| P1-up | 补 `GRAFANA_ADMIN_PASSWORD` secret → 触发 `action=up` → 产出新 CF 域名 | album-infra | **用户发话才点火；从此持续计费** / user go-ahead; cost starts |
| P1.5 | 用户把 `cx.chenyouyi.top` CNAME 改到新分发域名 | 域名服务商 | 用户操作 / user action |
| P2 | 六域真实数据验证、snapshot 状态验证、processor 生产镜像冒烟门禁与真实上传取证 | 四个仓库 | 换生产镜像前 double check |
| P3 | T-29 部署自动化、T-30 五条降级路径联调、T-31 安全隐私扫描、T-32 发布关卡记录 | 四个仓库 | — |
| P4 | 跑全部验收命令、出验收记录 | — | **用户签字验收** / sign-off |
| P5 | 验收后触发 `action=down` 一键关站；确认账单回落 | album-infra | 用户确认销毁范围 / confirm scope |

### 4.0 P1-code 进度 / Progress

**中文 / Chinese**

- ✅ P0.5 一键 up/down：PR #10 已合并，`mgmt-lifecycle.yml` 已注册 active，run 数为 0（从未点火）。
- ✅ **`#4 corr_… 贯穿` 已关闭**：PR #9 → 镜像 `bd9d1229aef8` → PR #11 → main apply run
  `43580970538`（两个 Lambda 换镜像）→ 真实上传 `corr_bb6f8616101611d0` 在两个 CloudWatch
  日志组贯穿 8 个阶段，CloudTrail 的 `CreateInvalidation` 也带同一 ID → 按基线清理完毕。
  完整证据见 `V5-ACCEPTANCE.md` 的「blocker #4 生产取证完成，判定关闭」一节。
- ✅ `FixtureData` 的 `planned` → `unknown`（fixture 侧，blocker #6）：album-mgmt PR #2 已合并，
  含 `FixtureStatusTest`；**真实只读清单适配器仍待做**，#6 未关闭。
- ✅ album-mgmt PR 不再向生产 ECR 推镜像（`container.yml` 的 5 个 publish 步骤加 PR gate）。
- ✅ **P1-code 剩余代码已合并入库（三个 PR 均已 merge；站点随后已点火，见 §4.2）**：
  - `album-mgmt`：`SdkAwsReadGateway` 真实只读映射覆盖 Resources / Logs / Metrics / Billing /
    CI-CD / Security 六域；`cloud` profile 注入真实 SDK clients（Cost Explorer / CloudFront 走
    us-east-1）；`AwsReadAdapterSupport` 统一限流、递归脱敏、诚实降级与契约结构化日志；
    日志域只放行结构化字段，绝不把原始日志行带出站。53 项 JUnit（新增 22 项）、`npm run check` 通过。
  - `album-infra`：`30-compute` 新增 `management_task` 最小权限只读 task role（`count` 受
    `mgmt_enabled` 门控，关站态零授权）、挂上 `task_role_arn`、注入 10 个只读环境变量；
    `terraform validate` / `fmt -check` / `check.mjs` 91 项全过。
  - CI 快照：`cicd-snapshot.yml` 用每次 run 自动下发的短期 `github.token` 采集三仓真实
    workflow runs，写入 `chenyouyi-mgmt-data/cicd/workflows.json`；管理站只 `GetObject`，
    **完全不直连 GitHub、无长期密钥**。复用 apply role 既有的 S3 写权限，不新增、不扩大 IAM。
    绑定 `production` 环境固定 OIDC subject；关站态只做只读采集校验、不写对象、不建资源，
    因此三仓覆盖可在开站前验证。离线用真实数据验证过 24 条 runs、三仓全覆盖、
    字段零越界、schema 与新鲜度均符合管理站 parser。
  - 护栏：`mgmt-lifecycle.yml` 移除写死的旧 digest 默认值，`up` 必须显式传 `sha256:<64hex>`，
    避免把缺少真实适配器的旧镜像拉起来。
- ✅ **合并前 double check 抓到并修掉 6 个缺陷**（前 4 个直接关系「真实运维数据」）：
  ① `metrics()` 原查询不带 `FunctionName` dimension，CloudWatch 返回空样本却被包装成
  `value=0` 的假数据行 → 现按 `MGMT_LAMBDA_FUNCTIONS` 逐函数带 dimension 查询，
  无样本直接降级，且修正 `Errors` 被错标为 milliseconds；新增 4 项零依赖单测。
  ② 日志 lookback 120 → 1440 分钟，避免按需拉起时 Logs 域空白。
  ③ `logs:FilterLogEvents` 的 IAM 资源 ARN 补 `:*` 形式，否则生产拉起后 Logs 域 403。
  ④ `cicd-snapshot.yml` 的 collect 原本被桶门控，关站态永远无法验证跨仓采集；
  现解耦为「始终采集、仅写入需桶存在」，并绑定 `production` 环境稳定 OIDC subject。
  ⑤ `build-image.yml` 的 `pull_request.paths` 不含 `spec/**`，纯文档 PR 不触发 required
  「单测 / unit tests」check，ruleset 永远等一个不存在的 check → 补 `spec/**`、`docs/**`、
  `README.md` 为触发路径。
  ⑥ `infra.yml` 的 `setup-terraform` wrapper 吞掉 `-detailed-exitcode` 的退出码 2，
  有变更的层在 CI 摘要里被写成「无变更」→ 改为按 plan 输出文本判定，并把
  `terraform show | head` 改为先落盘再 head 规避 SIGPIPE。分支九层只读 plan 与 main
  基线逐层一致，确认本批改动关站态零差异、无隐藏 IAM 授权。
- ⬜ **仍缺生产证据（代码就绪 ≠ 验收通过）**：站点已于 2026-11-14 点火成功（§4.2），
  但 #3 六域真实数据、#6 真实只读清单仍需在浏览器逐域核验；#2 生产故障注入、
  #5 三端浏览器记录、T-29~T-32 仍开放。`V5-ACCEPTANCE.md` 的判定**不因站点上线而改写**。

*English*
P0.5 one-click up/down is merged, registered and has never been triggered. **Blocker #4
is closed**: PR #9 built image `bd9d1229aef8`, PR #11 plus main apply run `43580970538`
deployed it to both Lambdas, and a real upload with `corr_bb6f8616101611d0` produced a
single-ID trace across both CloudWatch log groups and the CloudFront CallerReference,
followed by a byte-identical baseline restore. The fixture-side `planned → unknown` fix
landed in album-mgmt PR #2, but blocker #6 still needs the real read-only inventory
adapter. PRs no longer push images to the production ECR.

The remaining P1-code work is now code-ready but **not merged, not deployed and not
evidenced**: real AWS read adapters for all six domains with a cloud profile and 53
passing JUnit tests; a least-privilege read-only task role gated by `mgmt_enabled`; and
a CI-written S3 workflow snapshot so the management site never talks to GitHub and
holds no long-lived token. The lifecycle workflow no longer carries a stale default
image digest.

A pre-merge double check caught and fixed six defects, four of which would have
undermined "real operational data": (1) `metrics()` queried CloudWatch without a
`FunctionName` dimension and wrapped empty samples into fake `value=0` rows — it
now queries per function with the dimension, degrades when there are no samples,
and labels `Errors` as a count; four new dependency-free tests cover it; (2) the
log lookback grew from 120 to 1440 minutes; (3) the `logs:FilterLogEvents` IAM
ARNs gained the `:*` form; (4) snapshot collection is no longer gated on the
bucket, so cross-repo coverage is verifiable while the site is off, and the job
binds `environment: production` to pin the OIDC subject. (5) `build-image.yml`
did not trigger the required unit-test check for docs-only PRs; `spec/**`,
`docs/**` and `README.md` are now trigger paths. (6) The `setup-terraform`
wrapper in `infra.yml` swallowed `-detailed-exitcode` and reported pending
changes as "no changes"; detection now parses plan output text. A nine-layer
branch plan matched the main baseline layer by layer, confirming zero off-state
drift and no hidden IAM grants. Production evidence for #3/#6, failure injection
(#2), three-platform browser records (#5) and T-29~T-32 remain open;
`V5-ACCEPTANCE.md` is deliberately unchanged by this code batch.*

### 4.1 一键命令 / One-click commands

```bash
# 拉起 / bring up
# 前置 / prerequisites: secret MGMT_GRAFANA_ADMIN_PASSWORD (≥16 字符)
# 0) 可选：开站前在关站态验证快照采集（只读，不写任何 S3 对象）
#    看 job summary 的「覆盖仓库」是否为 3 / 3、「结论」是否为「仅采集校验」
gh workflow run cicd-snapshot.yml --repo scott372199/album-infra

# 1) 取 album-mgmt 当次 main CI 产出的镜像 digest（不写死、不用旧镜像）
DIGEST=$(aws ecr describe-images --repository-name album-mgmt --region ap-southeast-1 \
  --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageDigest' --output text)
# 2) 二次确认 + 显式 digest，一次触发拉起四层
gh workflow run mgmt-lifecycle.yml --repo scott372199/album-infra \
  -f action=up -f confirm=up -f image_uri="$DIGEST"

# 3) up 完成后 10-storage 已建桶，lifecycle 的 workflow_run 会自动刷新 CI 快照；
#    若需保鲜或自动刷新未跑，手动执行一次 / optional refresh before acceptance
gh workflow run cicd-snapshot.yml --repo scott372199/album-infra

# 关站 / switch off
gh workflow run mgmt-lifecycle.yml --repo scott372199/album-infra \
  -f action=down -f confirm=down
```

也可在 GitHub Actions 页面选 `up` / `down` 并把动作名再输一次作为二次确认。
**首次拉起的一次性前置顺序**：若 DNSPod 的 `cx.chenyouyi.top` CNAME 仍指向已删除的
旧分发，CloudFront 会以 `CNAMEAlreadyExists` 拒绝创建新分发。必须先暂停/删除该 CNAME
→ 触发 `up` 创建分发 → 把 CNAME 指向新分发域名。自 PR #17 起分发常驻（关站只置
`enabled=false`、alias 不释放），所以这套 DNS 操作一生只做一次，之后 `down` / `up`
都不再需要动 DNS。
工作流已在离线侧与真实点火两侧验证：YAML 解析、内嵌 shell 的 `bash -n`、
`scripts/check.mjs` 96 项、`terraform fmt -check` 全过，且第 7 次 `action=up`
已完整 apply 四层成功（见 §4.2）。
快照 workflow 不设定时任务，但 `infra` / `mgmt-lifecycle` 在 main 上跑完会自动触发
一次：关站态只读 `head-bucket` 后仍采集三仓 runs 做校验，桶不存在就**不写任何对象、
不创建任何资源**，因此三仓覆盖可在开站前确认。验收前若快照超过 180 分钟阈值，
手动 dispatch `cicd-snapshot.yml` 刷新一次即可。Logs 域窗口为 24 小时，若验收时该域
显示 `unavailable`，需按既有 E2E 流程做一次真实上传取证（含基线清理）以产生结构化日志。

*The same actions can be triggered from the Actions UI. **One-time prerequisite on
first bring-up**: if the DNSPod CNAME for `cx.chenyouyi.top` still points at the
deleted old distribution, CloudFront rejects creation with `CNAMEAlreadyExists`.
Suspend/delete that CNAME first, trigger `up`, then point the CNAME at the new
distribution. Since PR #17 the distribution persists (off only sets `enabled=false`
and keeps the alias), so this DNS work is done exactly once; later down/up cycles
need no DNS change. The workflows passed offline verification (YAML parse, `bash -n`
on embedded scripts, 96 structural assertions, `terraform fmt -check`) and the
seventh `action=up` applied all four layers successfully (§4.2). The snapshot
workflow has no schedule, but a completed `infra` or `mgmt-lifecycle` run on main
triggers it: while the site is off it still collects all three repositories for a
coverage check, yet writes **no object and creates no resource** when the bucket is
absent. Dispatch it once before acceptance if the snapshot is older than the
180-minute threshold. The Logs domain uses a 24h window; if it reports
`unavailable` during acceptance, run the existing E2E upload evidence flow
(including baseline restoration) to produce structured log events.*

### 4.2 点火实操记录 / Ignition log

**中文 / Chinese**

七次 `action=up`（`43597110203`、`43597476969`、`43598171391`、`43598540589`、
`43600884375`、`43601533802`、`43603205911`）；前六次逐层暴露了五个「从未点火就
发现不了」的缺陷：

| 中文 / Chinese | English |
| --- | --- |
| ① 裸 `sha256:<digest>` 被直接当成 ECS image → 读 `00-bootstrap` 的 `repository_url` 拼成 `repo@sha256:…`（PR #14） | ① A bare digest was passed as the ECS image; join it with the bootstrap `repository_url` (PR #14) |
| ② 模块级 `depends_on` 把 `data.aws_subnets` 推迟到 apply 期，`Invalid for_each argument` → 删掉冗余 gate 与依赖边（PR #15） | ② A module-level `depends_on` deferred `data.aws_subnets` to apply time; remove the redundant gate and dependency edge (PR #15) |
| ③ apply 角色缺 `s3:Get*` / ECS / EFS / ELB / EC2 / `CreateServiceLinkedRole` → 补 statement 并本地 apply（PR #15） | ③ The apply role lacked runtime IAM permissions; add the statements and apply them (PR #15) |
| ④ provider 6.x 读证书调 `acm:GetCertificate` 被拒 → `ACMRead` 补 ACM 只读三族（PR #16） | ④ Provider 6.x calls `acm:GetCertificate`; extend `ACMRead` with read-only ACM actions (PR #16) |
| ⑤ `CNAMEAlreadyExists`，且分发随关站销毁导致每次重建都重演 → 分发常驻、`enabled` 跟随开关、用户一次性改 CNAME（PR #17） | ⑤ `CNAMEAlreadyExists` recurred because the distribution was destroyed on shutdown; make it persistent and change the CNAME once (PR #17) |

第 7 次点火（`43603205911`，4m26s）四层结果：`00-bootstrap` 0 / `10-storage` 0 /
`30-compute` 0 changes（26 个资源已在线）/ `20-edge` **1 added**。
新分发 `E2VQ7PHXOKOIVY` = `d7shs93wdjmbm.cloudfront.net`，alias
`cx.chenyouyi.top`，Deployed / Enabled。`cloud` profile 在容器日志中确认生效，
`/actuator/health` 返回 `{"status":"UP"}`。

用户随后把 `cx` CNAME 指向 `d7shs93wdjmbm.cloudfront.net`，权威 NS 与递归解析
均生效，`https://cx.chenyouyi.top/actuator/health` 返回 `UP`。

**登录凭据已加固（album-infra PR #18，第 8 次点火 `43606180654`）**：原先 README
公开的演示共享口令、默认 scrypt pepper 与留空的 `MGMT_JWT_SECRET` 全部替换为随机
强值，经 GitHub secret → `TF_VAR` → SSM SecureString → ECS `secret{}` 按 ARN 注入；
执行角色补最小权限 SSM 读取策略，`check.mjs` 第 97 条断言禁止公开默认值与明文环境变量。
**口令只在对话中单独告知用户，不写入任何仓库或文档**；验收账户为 `admin`。
部署收敛后复验：旧口令 401、新口令 200（role=admin）。

**踩坑**：ECS Express 滚动部署约 9 分钟内新旧 task 并存，此时测登录会得到
「旧口令 200、新口令 401」的假阴性；必须等 `describe-service-deployments` 变
`SUCCESSFUL`、只剩一个 activeConfiguration 再验。

**七域预检**（新口令登录、直连 origin）：`resources` aws/6、状态 `active`（#6 不再误报
`planned`）、`logs` aws/15、`billing` aws/1、`cicd/workflows` aws/24、
`security` aws/5 `enforced`、`audit` fixture/8（本服务自身状态）；`metrics` 因 24h 内
无 Lambda 调用样本诚实降级为 `unavailable`，按既有 E2E 上传取证流程可产生指标。

**T-31 剩余待办**：日志已见公网扫描器探测 `META-INF/.../pom.properties`；且 ECS
Express 的 origin 域名可绕过 CloudFront 公网直连（预检即借此完成 POST 登录验证），
需评估是否加 Origin 自定义头或源站访问控制。

*English*

Seven `action=up` runs; the first six exposed five defects that only a real
ignition could reveal (see the bilingual table above). Run seven (`43603205911`,
4m26s) applied all four layers: 0 / 0 / 0 changes and **1 added** in 20-edge.
The new distribution `E2VQ7PHXOKOIVY` (`d7shs93wdjmbm.cloudfront.net`) carries the
`cx.chenyouyi.top` alias and is Deployed / Enabled; container logs confirm the
`cloud` profile and `/actuator/health` returns `{"status":"UP"}` after the user
pointed the CNAME at the new domain.

**Credentials were hardened (PR #18, eighth ignition `43606180654`)**: the public
demo shared key, default scrypt pepper and empty `MGMT_JWT_SECRET` were replaced
with random strong values flowing from GitHub secrets through `TF_VAR` into SSM
SecureString parameters and into the container via ECS `secret{}` ARNs. A
least-privilege SSM read policy was added to the execution role and assertion #97
forbids public defaults and plaintext environment variables. **The password is
shared with the user only in conversation, never in a repository or document**;
the acceptance account is `admin`. After the deployment converged, the old
password returns 401 and the new one 200 (role=admin).

**Pitfall**: ECS Express rolling deployments keep old and new tasks side by side
for about nine minutes; testing login during that window produces a false negative
(old 200 / new 401). Wait until `describe-service-deployments` reports
`SUCCESSFUL` and only one active configuration remains.

A seven-domain pre-flight with the new password (direct to the origin) returned
`aws` sources for resources (6, status `active`, no more false `planned`), logs
(15), billing (1), CI/CD (24) and security (5, `enforced`); audit is `fixture`/8 by
design, and metrics honestly reports `unavailable` because there are no Lambda
invocations in the 24h window. **Remaining T-31 work**: internet scanners are
already probing `META-INF/.../pom.properties`, and the ECS Express origin can be
reached directly from the internet, bypassing CloudFront — consider a custom
origin header or origin access control.*

## 5. 验收触发条件 / Acceptance trigger

- [ ] 6 个 release blockers 各有生产证据；#1 的六示例例外由用户在 T-32 签字确认
- [ ] T-29 / T-30 / T-31 / T-32 在 `tasks.md` 中更新为有证据的完成
- [ ] `curl https://cx.chenyouyi.top/`、`/actuator/health`、`/api/management/snapshot` 三条通过
- [ ] `curl https://photos.chenyouyi.top/` 通过；`npm test`、`npm run build` 通过
- [ ] 无 drift：九层 `terraform plan` 全绿（up 期间 management 层的预期 diff 已记录）
- [ ] 一键 down 已演练过（或明确列为验收后立即执行项）
- [ ] 验收记录（含性能、成本、告警、回滚、已知限制）交用户签字

*All blockers evidenced (with the signed #1 exception), T-29~T-32 closed, all
required commands passing, no unexplained drift, one-click down rehearsed or
scheduled, and a signed acceptance record.*

## 6. 回滚 / Rollback

`action=down` 一键销毁运行时而保留 ECR、数据桶、state 与证书；processor 可回退到上一个
已冒烟的镜像 digest；DNS 可切回原 CNAME；photos 站四层 state 与管理站完全独立。

*One-click down removes the runtime while keeping ECR, the data bucket, state and
the certificate; the processor rolls back to the last smoke-tested digest; the CNAME
can be reverted. The photo site's state is fully independent.*

## 7. 非目标 / Non-goals

不引入管理站写 API、不放宽只读边界、不引入长期密钥、不删除旧 App Runner 路径、
不在 V5 内实现 embedding、不把 V6 B-01~B-05 的产品优化混进本轮
（#1 六示例相关优化按 D-D 延至 V6）。

*No write APIs, no loosening of the read-only boundary, no long-lived credentials,
no App Runner deletion, no embeddings, and no V6 product work in this round.*
