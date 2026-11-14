# V5 全矩阵验收执行计划 / V5 Full-Matrix Acceptance Plan

> 2026-11-14。用户选定「按 `V5-ACCEPTANCE.md` 全矩阵验收」，即不缩范围、不降口径。
> 本文是执行顺序与决策记录，不替代验收矩阵；判定仍只看 `V5-ACCEPTANCE.md`。
> **决策已定，当前阶段不点火、不产生持续计费**：先把代码与一键能力做就绪，
> 拉起由用户发话，用户验收后再一键销毁。
>
> *On 2026-11-14 the user chose full-matrix acceptance. This is the execution order
> and decision record; the acceptance matrix remains the only gate. **Decisions are
> made and nothing is switched on yet**: code and one-click lifecycle come first,
> bring-up waits for the user's go-ahead, and teardown follows acceptance.*

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
- ✅ `#4 corr_… 贯穿（代码侧）`：`个人相册` 仓库已完成，设计、离线证据与仍缺的生产取证
  见 `V5-ACCEPTANCE.md` 的「blocker #4 correlation ID 代码就绪」一节。**此项不点火、不计费**，
  待 PR 合并产出新镜像后，换生产镜像并做一次真实上传取证才算关闭。
- ⬜ 真实适配器 + 最小权限 task role + CI 只读快照 + `cloud` profile（album-mgmt / album-infra）。
- ⬜ `FixtureData` 的 `planned` → `unknown` / 真实清单（blocker #6）。
- ⬜ #2 生产故障注入证据、#5 三端浏览器记录、T-31 安全评审。

*English*
P0.5 one-click up/down is merged, registered and has never been triggered. The code
side of blocker #4 is done in the `album` repo (see `V5-ACCEPTANCE.md`); it needs no
infrastructure and no cost, but stays open until a new image is deployed and a real
upload produces a single-ID production trace. Real adapters, the least-privilege task
role, the CI read-only snapshot, the `planned` fix, failure-injection and browser
evidence and the T-31 review remain open.*

### 4.1 一键命令 / One-click commands

```bash
# 拉起 / bring up（前置：secret MGMT_GRAFANA_ADMIN_PASSWORD，≥16 字符）
gh workflow run mgmt-lifecycle.yml --repo scott372199/album-infra \
  -f action=up -f confirm=up \
  -f image_uri=sha256:366e16939127214f8170365f888b1fcdfff611736c93fef1fb3fc7145edac47d

# 关站 / switch off
gh workflow run mgmt-lifecycle.yml --repo scott372199/album-infra \
  -f action=down -f confirm=down
```

也可在 GitHub Actions 页面选 `up` / `down` 并把动作名再输一次作为二次确认。
`up` 完成后从 job summary 取新 CloudFront 域名，由用户改 CNAME；`down` 只销毁运行时。
工作流本身已在离线侧验证：YAML 解析、4 段内嵌 shell 的 `bash -n`、
`scripts/check.mjs` 91 项、`terraform fmt -check` 全过，**且从未触发过任何 apply**。

*The same actions can be triggered from the Actions UI. Offline verification of the
workflow (YAML parse, `bash -n` on all embedded scripts, 91 structural assertions,
`terraform fmt -check`) passed; no apply has ever been triggered.*

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
