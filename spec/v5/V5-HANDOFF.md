# V5 收尾交接 / V5 Closure Handoff

> 2026-11-15。V5 已由用户决定收尾，状态 `CLOSED WITH EXCEPTIONS`（带例外关闭）；
> 当前迭代是 **V6**。本文是下一个 agent 读取「云上现状」的入口：判定只看
> `V5-ACCEPTANCE.md`，过程记录看 `V5-FULL-ACCEPTANCE-PLAN.md`，下一轮范围看 `spec/v6/`。
> **不要从聊天记录推断云状态**，先执行第 5 节的只读检查。
>
> *As of 2026-11-15 V5 is closed with exceptions and V6 is the active iteration.
> This is the entry point for the current cloud state. The verdict lives in
> `V5-ACCEPTANCE.md`, the process log in `V5-FULL-ACCEPTANCE-PLAN.md` and the next
> iteration's scope in `spec/v6/`. Never infer cloud state from chat history —
> run the read-only checks in §5 first.*

## 1. 迭代状态 / Iteration status

| 项 / Item | 事实 / Fact |
| --- | --- |
| V5 | 逐域验收通过 + 用户决定收尾；**非 `fully accepted`**，未满足项整体结转 V6 |
| V6 | 进行中：`spec/v6/{spec,plan,tasks}.md` 与 `backlog.md` B-01~B-07 |
| photos 站 | 线上稳定，`https://photos.chenyouyi.top/`，与管理系统零共享资源 |
| 管理站 | **常态关站**：CDN 分发常驻但 `enabled=false`，`30-compute` 运行时已销毁 |
| 计费 | 管理站持续计费已停止；ECR 镜像、数据桶、state、ACM 证书保留 |

*V5 passed domain acceptance but is not fully accepted; outstanding items carry over
to V6. The photo site is live; the management site is off by default with a
persistent-but-disabled CDN, so runtime billing is stopped while durable assets survive.*

## 2. 线上资产 / Live assets

| 资产 / Asset | 标识 / Identifier | 说明 / Note |
| --- | --- | --- |
| photos CloudFront | `E2UWEFMOKOQEES` / `d3mvmo06veyiuk.cloudfront.net` | OAC → 私有 S3 站点桶 |
| 管理站 CloudFront | `E2VQ7PHXOKOIVY` / `d7shs93wdjmbm.cloudfront.net` | **常驻分发**；DNS CNAME `cx.chenyouyi.top` 固定指向它，**不要每次改 DNS** |
| 管理站数据桶 | `chenyouyi-mgmt-data` | 保留；CI/CD 只读快照对象 `cicd/workflows.json` |
| 管理站镜像 | ECR `album-mgmt` | 按不可变 `sha256:<64hex>` digest 固定，**绝不用 `latest`** |
| state | `chenyouyi-tfstate` 下 `management/` 四层与 photos 各层 | 分层独立，按前缀分域 |
| 鉴权凭据 | GitHub secrets → SSM SecureString `/album/mgmt/*` → ECS `secret{}` | 共享口令只在对话中单独提供，**不写入任何仓库文件** |

*The management distribution is persistent by design: destroying and recreating it
would make the external CNAME dangle and break one-click up/down. Credentials are
injected through SSM SecureString; task definitions only expose ARNs.*

## 3. 一键生命周期 / One-click lifecycle

PR #22 快路径后的真实顺序 / Actual order after the PR #22 fast path：
`up` 只 **apply** `30-compute → 20-edge`；`00-bootstrap` 仅 `init` 读取 `repository_url`
output，`10-storage` 不进生命周期（其 IaC 变更由 `infra.yml` 管）。
`down` 只 apply `20-edge → 30-compute`。所有层并行 `terraform init`，常驻层永不销毁。

*After the fast path, up applies only compute and edge; bootstrap is initialised solely*
*to read the ECR repository URL and storage is owned by infra.yml. Down reverses edge*
*and compute. Terraform init runs in parallel and persistent layers are never destroyed.*

```bash
# 拉起 / up（digest 必须动态取当次 CI 产物，不要写死）
DIGEST=$(aws ecr describe-images --repository-name album-mgmt --region ap-southeast-1 \
  --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageDigest' --output text)
gh workflow run mgmt-lifecycle.yml --repo scott372199/album-infra --ref main \
  -f action=up -f confirm=up -f image_uri="$DIGEST"
gh workflow run cicd-snapshot.yml --repo scott372199/album-infra

# 销毁 / down
gh workflow run mgmt-lifecycle.yml --repo scott372199/album-infra --ref main \
  -f action=down -f confirm=down
```

耗时基线 / Measured baseline：冷启动 up **6m35s**、重复 up **2m24s**、down **11m42s**。
`album-infra` PR #22 的快路径（跳过常驻层、并行 init、关站不等 CDN 部署）预计
重复 up ≈1m20s、down ≈9m。**用户目标是一键 up/down 都 ≤60s，已记为 V6 B-07**；
瓶颈是 ECS Express Gateway Service 删除的 ~8 分钟（AWS 控制面），需架构级改造，
不是 workflow 编排能解决的。详见 `V5-FULL-ACCEPTANCE-PLAN.md` §4.4。

*Measured: cold up 6m35s, repeat up 2m24s, down 11m42s. The fast path should bring
them to ~1m20s and ~9m. The user's ≤60s target is V6 B-07; the ~8-minute ECS Express
service deletion is an AWS control-plane cost requiring an architectural change.*

## 4. 管理站 API 与 CDN 契约 / Management API and CDN contract

- 正式 UI：`GET /` 返回登录页；`POST /api/v1/auth/login`（`principal` + 共享口令）→ Bearer。
- 七域只读：`/api/v1/{resources,logs,metrics,billing,cicd/workflows,security,audit}`。
- **旧端点 `GET /api/management/snapshot` 已 404**，不要再引用；blocker #6 的
  「不把 ACTIVE 报成 planned」已由真实 `resources` 适配器满足。
- CDN 三个必须**同时**满足的配置，缺一个就会出现「页面能开但用不了」：
  1. `allowed_methods` 必须含 `POST`（登录），`cached_methods` 仍 `GET/HEAD` 且
     `CachingDisabled`；
  2. `origin_request_policy_id = Managed-AllViewerExceptHostHeader` —— 转发
     `Authorization`，**不能用裸 `Managed-AllViewer`**，它会把 viewer 的 `Host` 转给
     按 Host 路由的 ECS Express ALB，导致全站 `404 / awselb/2.0`；
  3. `wait_for_deployment = var.mgmt_enabled` —— 关站跳过 CDN 传播等待，拉起仍等，
     且 up 前置 `aws cloudfront wait distribution-deployed`。
- `album-infra/scripts/check.mjs` 的 **101 项断言**锁定上述边界与 photos 站不受影响。
- 已知缺口：`metrics` 诚实 `source=unavailable`、`audit` 仍 `source=fixture`，结转 V6。

*Three CDN settings are jointly required; the plain Managed-AllViewer policy forwards
the viewer Host and makes the ALB return 404 for every request. The legacy snapshot
endpoint is gone. Metrics and audit remain V6 work.*

## 5. 给下一个 agent 的先读清单 / Read first

1. **四查**：`git fetch origin --prune` → `gh pr list --state open` →
   `git branch -r --no-merged origin/main` → `git status --short`。
2. 三个仓库一律按「他人随时在改」处理；所有提交作者都显示 `xin chen`，
   **不能用作者名判断归属**；新分支一律从 `origin/main` 切。
3. 不直接 push `main`；改动走 PR；他人开的 PR 只 double check 与报告，绝不代合并；
   已推送分支只用 `git merge origin/main` 同步，不 force push。
4. 云状态一律用 AWS API / `terraform plan` 读回，不靠聊天记忆或本文件的静态值。
5. 判定只看 `V5-ACCEPTANCE.md`；`tasks.md` 的 ✅ 只表示代码入库。
6. 外部写操作（AWS apply、换生产镜像、推送）动手前先向用户确认。

*Treat every repo as concurrently edited. Authorship is not ownership. Confirm
external writes with the user first. Read cloud state from the APIs, not from chat.*

## 6. V5 未竟事项 / Carried over to V6

完整结转表见 `V5-ACCEPTANCE.md`「V5 收尾与结转」。摘要：blocker #1 / #2 / #3 / #5 / #6、
T-29~T-32、前端 V6 与服务端 V5 镜像对齐（`prod.tfvars` 仍指向旧 tag），
以及 `spec/v6/backlog.md` B-01~B-07（B-07 = 生命周期 ≤60s）。
V5 冻结，不回改；新需求一律写进 `spec/v6/`。

*The full carry-over table is in `V5-ACCEPTANCE.md`. V5 is frozen; all new scope
belongs in `spec/v6/`.*

## 7. 明确不做 / Explicit non-goals

- 不在 V5 补写「已完全验收」；不伪造生产证据、不把 fixture 冒充真实运维数据。
- 不在交接文档里放口令、token、AWS 账号 ID、Terraform state 或原始照片。
- 不为了凑验收往私人相册塞非个人照片；不开启管理站写操作而不重做安全评审。

*Do not claim full V5 acceptance, fabricate evidence, store credentials in this
handoff, pad the private album with unrelated photos, or enable management write
APIs without a fresh security review.*
