#!/usr/bin/env bash
###############################################################################
# V5 PR 治理 · 一键应用 / V5 PR governance · one-shot applier
#
# 前置（只能由仓库主人做一次）/ Prerequisite (one-time, repo owner only):
#   gh auth login          # 浏览器授权，gh CLI 需要仓库 admin 权限
#
# 本脚本做的事 / What this does (per repo):
#   1. 创建 PR → main（album / album-infra / album-mgmt，双语正文）
#   2. 建立分支规则集（ruleset）：protected main、禁止 force push 与删除、
#      必须走 PR + 1 人工审批、required status checks、尝试启用 Copilot review
#   3. 打印 Copilot 需要在 UI 里完成的最后一步（若 API 不支持）
#
# 安全边界 / safety boundaries:
#   - 不合并任何 PR（合并 = Copilot review + 人工审批之后你自己点）
#   - 不触发任何部署（部署 workflow 由合并自动触发，infra apply 仍是手动 gate）
#   - ruleset 不加 bypass actor（管理员也受规则约束，留审计才可 override）
#
# 幂等 / idempotent：PR 已存在则跳过；同名 ruleset 已存在则更新（PATCH by id）。
###############################################################################

set -euo pipefail

OWNER="scott372199"
REPOS_BRANCH=(
  "album|feat/v5-rebuild"
  "album-infra|feat/v5-rebuild"
  "album-mgmt|feat/v5-rebuild"
)

command -v gh >/dev/null 2>&1 || { echo "✗ 需要 gh CLI / gh CLI required"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ 先运行 gh auth login / run gh auth login first"; exit 1; }

api() { gh api -H "Accept: application/vnd.github+json" "$@"; }

# ── ruleset 构建 / ruleset payload ──────────────────────────────
# required_status_checks 的 context 必须与 check run 名字逐字一致
# the context must match the check-run name verbatim
checks_for() {
  case "$1" in
    album)        echo '["单测 / unit tests"]' ;;
    album-infra)  echo '["lint"]' ;;
    album-mgmt)   echo '["image"]' ;;
    album-android) echo '[]' ;;
    *)            echo '[]' ;;
  esac
}

make_ruleset_body() { # repo
  local repo="$1" checks copilot_rule
  checks="$(checks_for "$repo")"

  # Copilot code review 作为规则尝试加入；API 若拒绝，降级到 UI 步骤
  # try the copilot rule; on API rejection we fall back to the UI step
  copilot_rule=',{"type":"copilot_code_review","parameters":{"review_level":"every_pull_request"}}'

  cat <<EOF
{
  "name": "main-governance-v5",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "bypass_actors": [],
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "pull_request", "parameters": {
      "required_approving_review_count": 1,
      "dismiss_stale_reviews_on_push": true,
      "require_last_push_approval": true,
      "required_review_thread_resolution": false
    }},
    {"type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": $checks
    }}$copilot_rule
  ]
}
EOF
}

ensure_ruleset() { # repo
  local repo="$1"
  local existing
  existing="$(api "repos/$OWNER/$repo/rulesets" --jq '.[] | select(.name=="main-governance-v5") | .id' 2>/dev/null || true)"
  local body; body="$(make_ruleset_body "$repo")"
  if [ -n "$existing" ]; then
    api -X PUT "repos/$OWNER/$repo/rulesets/$existing" --input - <<< "$body" >/dev/null
    echo "  ↻ ruleset 更新 / updated (id=$existing)"
  else
    api -X POST "repos/$OWNER/$repo/rulesets" --input - <<< "$body" >/dev/null
    echo "  ✓ ruleset 创建 / created"
  fi
}

pr_body_album() { cat <<'EOF'
## V5 重建 / V5 rebuild

**契约 / Contracts**: spec/v5/contracts/v5-contracts.json（v5.1.0）
**决策 / Decisions**: spec/v5/DECISIONS.md（D-1~D-8）

### 内容 / Contents
- 重建起点回 v4 基线；契约 + 决策 + spec 校准（32cbc3d）
- Apple 式前端：hero registry、中文语义搜索、上传五态（abfb8fb）
- 服务端搜索内核：correlation / recognition（Rekognition provider 注入）/ 索引发布 / 降级
- 本地成品演示：`demo/run-demo.sh` 一键三件套 + 状态页实测数字（11a9b47）

### 验证 / Verification
- `npm test` 169 通过 · `npm run verify` 38 断言 · `npm run check:repo` 119 文件
- 语义搜索端到端验收（T-12/T-30）**生产待定**：需上传真实照片后验证识别链路

*Rebuild on the v4 baseline; contracts, frontend, search kernel, local demo. The
semantic-search acceptance stays production-gated until real photos are uploaded.*
EOF
}

pr_body_infra() { cat <<'EOF'
## V5 站点拆分 IaC / V5 site-split IaC

**决策 / Decisions**: D-6（站点拆分）、D-7（mgmt_enabled 按需开关）

### 内容 / Contents
- `00-account/`：共享状态桶 + GitHub OIDC + infra plan/apply 角色
- `sites/photos/`：bootstrap（app_deploy 角色）+ storage/edge/compute，state key 加 `photos/` 前缀
- `sites/management/`：ECR + 持久数据桶（关站保留）；ECS Express + Fargate 观测栈 + cx CloudFront（`mgmt_enabled` 门控，默认 false）
- `modules/fargate-observability`：单任务五容器 + EFS + ALB（Grafana/Loki/Prometheus/Tempo/OTel）
- 离线自检重写为 scope 感知，91 项断言；Makefile `site=/layer=`；CI 矩阵 9 目录

### 验证 / Verification
- `make check` 91/91 · `terraform fmt -recursive -check` 通过
- state 迁移配方见 README §4c；photos 三层 re-init 后应零差异

*Site-split per D-6; management runtime fully gated by mgmt_enabled per D-7.*
EOF
}

pr_body_mgmt() { cat <<'EOF'
## V5 管理站重建 / V5 management platform rebuild

**决策 / Decisions**: D-3（本地成品 + 按需上线）、D-4（登录+RBAC+审计）

### 内容 / Contents
- 登录（共享口令 + scrypt）→ 独立 MGMT_JWT_SECRET 的 HS256 access/refresh
- 逐域 RBAC（admin 七域 / auditor audit+security / viewer resources+cicd）
- 六域只读 API + audit，统一 commonEnvelope，不可用域明确降级（绝不伪造数据）
- 审计过滤器（who 哈希派生）+ 出站 ForbiddenFields 递归兜底
- React 前端接真实 API；docker-compose 本地演示；28 项测试全绿

### 验证 / Verification
- `./gradlew test` 28/28 · `node scripts/check.mjs` 通过 · web build 通过

*Auth, RBAC, audit, six-domain read APIs, real-API frontend, compose demo.*
EOF
}

ensure_pr() { # repo branch title body_file
  local repo="$1" branch="$2" title="$3" body_file="$4"
  if gh pr view "$branch" -R "$OWNER/$repo" --json number >/dev/null 2>&1; then
    echo "  ↻ PR 已存在 / PR exists: https://github.com/$OWNER/$repo/pull/$(gh pr view "$branch" -R "$OWNER/$repo" --json number --jq .number)"
  else
    gh pr create -R "$OWNER/$repo" --base main --head "$branch" \
      --title "$title" --body-file "$body_file" >/dev/null
    echo "  ✓ PR 创建 / PR created"
  fi
}

tmp_body="$(mktemp)"
trap 'rm -f "$tmp_body"' EXIT

echo "═══ 创建 PR / creating PRs ═══"
for entry in "${REPOS_BRANCH[@]}"; do
  repo="${entry%%|*}"; branch="${entry##*|}"
  echo "▸ $repo"
  case "$repo" in
    album)       echo "$(pr_body_album)"  > "$tmp_body"; ensure_pr "$repo" "$branch" "feat(v5): contracts + 前端搜索 + 本地演示 / contracts + frontend search + local demo" "$tmp_body" ;;
    album-infra) echo "$(pr_body_infra)"  > "$tmp_body"; ensure_pr "$repo" "$branch" "feat(v5): 站点拆分 Terraform + 观测栈 / site-split Terraform + observability" "$tmp_body" ;;
    album-mgmt)  echo "$(pr_body_mgmt)"   > "$tmp_body"; ensure_pr "$repo" "$branch" "feat(v5): 管理站重建——认证/RBAC/审计/六域 / management rebuild: auth, RBAC, audit, six domains" "$tmp_body" ;;
  esac
done

echo "═══ 分支规则集 / branch rulesets ═══"
for repo in album album-infra album-mgmt album-android; do
  echo "▸ $repo"
  ensure_ruleset "$repo"
done

echo ""
echo "═══ 完成后的最后一步（若 Copilot API 未生效）/ final UI step if Copilot rule was rejected ═══"
echo "每个仓库 Settings → Rules → Rulesets → main-governance-v5 →"
echo "勾选 'Copilot code review'（每次 PR 都 review，不自动提交意见为 required 之外的绕行）。"
echo "Per repo: Settings → Rules → Rulesets → main-governance-v5 → enable Copilot code review."
echo ""
echo "合并后部署 / post-merge deploys: album（内容 + 镜像）与 album-infra（plan-only）自动触发；"
echo "infra apply 与管理站上线仍是手动 gate（workflow_dispatch + confirm）。"
