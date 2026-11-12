# CI/CD 架构：Terraform + AWS + GitOps 是怎么串起来的 / How the pieces fit

> 这份文档回答一个问题：**代码推上去之后，到底是什么在动、凭什么能动、动错了怎么退。**
> 它假定你了解 Git 和命令行，但不假定你用过 OIDC、IAM role 或 Terraform。
> 真实值（账号 ID、角色 ARN、桶名）放在私有仓库 `album-infra` 的输出与本机笔记里，
> 本文一律用 `<ACCOUNT_ID>` 这类占位符，方便你照着理解而不是照抄。
>
> *This answers one question: after a push, what actually moves, on whose authority,
> and how do you roll back. It assumes Git and a shell, not OIDC, IAM or Terraform.*

---

## 0. 先看全景 / The whole picture

```
   ┌── 你（本机）────────┐        ┌── GitHub ──────────────────────────────┐
   │ git push           │───────▶│ album        → deploy-web / build-image │
   │ terraform apply    │        │ album-infra  → infra（plan；apply 手动） │
   │ gradlew + 发布 APK  │        │ album-android→ 无 CI（签名只在本机）     │
   └─────────┬──────────┘        └───────────────┬────────────────────────┘
             │                                   │ OIDC JWT（1 小时）
             │ AWS CLI 长期凭证                    ▼
             │                          ┌── AWS STS ──┐ 验签后发临时凭证
             │                          └──────┬──────┘
             ▼                                 ▼
        ┌────────────────────────────────────────────────┐
        │ 三个 IAM Role（各自的权限边界，互不越界）         │
        │  album-gha-app-deploy   发内容 + 推镜像          │
        │  album-gha-infra-plan   只读 + 拿 state 锁       │
        │  album-gha-infra-apply  改基础设施               │
        └───────────────────┬────────────────────────────┘
                            ▼
        ┌────────────────────────────────────────────────┐
        │ Terraform 四层（state 在 S3）                   │
        │  00-bootstrap → 10-storage → 20-edge → 30-compute│
        └────────────────────────────────────────────────┘
```

一句话：**人只做两件事——推代码、点一次 apply。其余每一次AWS调用都由一个只有几十分钟
寿命的临时凭证完成，而这个凭证能做什么，完全由 Terraform 里写的信任策略决定。**

*Humans do two things: push code, and click apply once. Every other AWS call uses a
short-lived credential whose blast radius is written down in Terraform.*

---

## 1. 三个仓库 = 三条信任边 / Three repos, three trust edges

| 仓库 | 谁在看它 | 它能改什么 | 凭什么 |
| --- | --- | --- | --- |
| `album`（公开） | 所有人 | 站点内容（`assets/`、`index.html`）、ECR 镜像 | OIDC → `album-gha-app-deploy` |
| `album-infra`（私有） | 只有你 | 全部基础设施 | OIDC → `album-gha-infra-plan` / `-apply` |
| `album-android`（公开） | 所有人 | 什么都没有 | 没有角色，CI 不碰云 |

三条边分开的理由很实际：**「改一张图」和「改一条 CloudFront 行为」不是一个量级的操作。**
如果一个角色什么都能干，那么任何一次往公开仓库推 PR 的人都可能间接拿到改基础设施的能力。

*The edges are separate because publishing a photo and rewriting a CDN behaviour are not the
same class of operation. One role for both means anyone who can touch the public repo can
indirectly reach infrastructure.*

---

## 2. OIDC 到底解决了什么 / What OIDC actually buys you

### 2.1 上一代做法为什么不行

把 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 存进 GitHub Secrets，用的时候读出来。
问题不在「会不会泄漏」，在**它永远有效**：泄漏一次，攻击者可以在任何地方、任何时间用，
而你无法区分「这是 CI 在用」还是「这是别人在用」。

### 2.2 OIDC 换了一个问题

GitHub 每次运行 job 时，会给这个 job 签发一个 **JWT**（JSON Web Token），内容大致是：

```json
{
  "iss": "https://token.actions.githubusercontent.com",
  "aud": "sts.amazonaws.com",
  "sub": "repo:scott372199/album:ref:refs/heads/main",
  "repository": "scott372199/album",
  "ref": "refs/heads/main",
  "exp": 1765000000
}
```

Workflow 里写 `permissions: id-token: write`，这个 JWT 才会被签出来。然后
`aws-actions/configure-aws-credentials` 把它交给 AWS STS：

```
POST https://sts.amazonaws.com/
Action=AssumeRoleWithWebIdentity
&RoleArn=arn:aws:iam::<ACCOUNT_ID>:role/album-gha-app-deploy
&WebIdentityToken=<那个 JWT>
```

STS 做三件事：验签（确认是 GitHub 签的）→ **比对 `sub` 是否匹配角色的信任策略** →
发一组有效期 1 小时的临时凭证。job 结束即失效。

所以真正的安全边界不是「密钥藏得好不好」，而是**信任策略里那几行 `sub` 条件**。

*GitHub signs a short-lived JWT per job; STS verifies it and checks the `sub` claim against the
role's trust policy. The security boundary is that policy, not secret storage.*

### 2.3 一个必须知道的坑：`sub` 有两种格式

```
repo:scott372199/album:ref:refs/heads/main                      ← 老仓库
repo:scott372199@175766495/album@1453810297:ref:refs/heads/main ← 新仓库（带数字 ID）
```

GitHub 正在给新旧仓库签发不同格式。只写一种，另一种就是 `AccessDenied`，而错误信息会
伪装成「Credentials could not be loaded」，完全看不出是主体名对不上。本项目的做法是两种都认，
数字 ID 用 `@*` 通配：

```hcl
app_subject    = "repo:${var.github_org}/${var.app_repo}"
app_subject_id = "repo:${var.github_org}@*/${var.app_repo}@*"
```

第二个坑：**job 一旦声明 `environment: production`，`sub` 里的 `ref` 段会被换成
`environment:production`**。所以 deploy-web 那条边要同时列出两种 `sub`。

*Two shapes of `sub` exist; write both. And declaring an `environment` replaces the ref segment
with `environment:<name>`, so that variant must be listed too.*

---

## 3. 三个角色 / The three roles

### 3.1 权限边界

| 角色 | 能做 | 明确不能做 |
| --- | --- | --- |
| `album-gha-app-deploy` | `s3:Put/Delete/GetObject` on 站点桶；`s3:ListBucket`；`cloudfront:CreateInvalidation`；`ecr:PutImage` 等推镜像权限 | 碰 state 桶、改 IAM、改 CloudFront 配置 |
| `album-gha-infra-plan` | `ReadOnlyAccess` + state 桶读写 + 拿锁 | 任何写操作 |
| `album-gha-infra-apply` | 基础设施全权（相当于本层管理员） | —— |

为什么推镜像的权限给了「内容发布」角色而不是「基础设施」角色？因为镜像是应用仓库的 CI
构建的。如果归基础设施角色，那「改一张图」的流水线就顺带拿到了改基础设施的能力。

*Image push belongs to the content role because the app repo's CI builds it. Giving it to the
infra role would hand infra privileges to every image bump.*

### 3.2 信任策略逐行读

```hcl
statement {
  actions = ["sts:AssumeRoleWithWebIdentity"]

  principals {
    type        = "Federated"
    identifiers = [aws_iam_openid_connect_provider.github.arn]
  }

  # ① 谁签的：必须是 GitHub 的 OIDC，且受众必须是 STS
  condition {
    test     = "StringEquals"
    variable = "token.actions.githubusercontent.com:aud"
    values   = ["sts.amazonaws.com"]
  }

  # ② 哪个仓库、哪个分支/环境：这一条才是真正的权限边界
  condition {
    test     = "StringLike"     # 因为要通配 @*，必须用 StringLike
    variable = "token.actions.githubusercontent.com:sub"
    values = [
      "repo:scott372199/album:ref:refs/heads/main",
      "repo:scott372199@*/album@*:ref:refs/heads/main",
      "repo:scott372199/album:environment:production",
      "repo:scott372199@*/album@*:environment:production",
    ]
  }
}
```

`StringEquals` 还是 `StringLike` 是个易错点：只要用了 `*`，就必须 `StringLike`，
用 `StringEquals` 会静默不匹配。

*`StringEquals` vs `StringLike`: the moment you use a wildcard, you need `StringLike`. Using
`StringEquals` silently never matches.*

### 3.3 为什么 apply 是手动触发

GitHub 的 **required reviewers**（合并后停在审批门）只对**公开仓库**开放，Free/Pro/Team
套餐下私有仓库需要 Enterprise。`album-infra` 必须私有（里面有账号结构），所以换了一个更硬的
门槛：**合并到 main 只跑 plan；apply 必须人手动 dispatch，并在 `confirm` 输入框里再打一次
`apply`。** 合并永远不会触发写操作。

*Required reviewers is public-repo-only below Enterprise. Since the infra repo must stay
private, the gate is a manual dispatch plus a second confirmation: merging never writes.*

---

## 4. Terraform 的四层 / The four layers

### 4.1 为什么分层

一次性写完也能跑，但改一次就是「重画整张图」。分层后每一层的 `terraform plan` 只显示自己
那一小块差异，出错面小、回滚也小。

| 层 | 管什么 | 依赖 |
| --- | --- | --- |
| `00-bootstrap` | 状态桶、OIDC provider、三个 IAM 角色 | 无（它不能管理自己） |
| `10-storage` | 站点桶、源桶、下载桶、桶策略、通知配置 | bootstrap 的角色 |
| `20-edge` | CloudFront 分发、OAC、ACM 引用、`/apk/*` 行为 | storage 的桶名 |
| `30-compute` | Lambda 两个函数、API Gateway、DynamoDB 限流表、SSM 参数、DLQ | storage + edge |

依赖严格单向：`00 → 10 → 20 → 30`。

### 4.2 state 放哪

每层独立一份 state，存在同一个桶的不同 key 下：

```hcl
# layers/30-compute/backend.hcl
bucket       = "chenyouyi-tfstate"
key          = "30-compute/terraform.tfstate"
region       = "ap-southeast-1"
use_lockfile = true     # Terraform ≥1.10 的 S3 原生锁（条件写）
encrypt      = true
```

`use_lockfile = true` 取代了老的 DynamoDB 锁表：少一个资源、少一份权限、少一处故障点。
两个人同时 apply 时，后到的那个会拿不到锁而不是把 state 写坏。

*One state per layer, same bucket, different keys. Native S3 locking replaced the DynamoDB
lock table — one less resource and one less failure mode.*

### 4.3 层之间怎么传值

不共享 state，而是**下游用 `terraform_remote_state` 读上游的输出**：

```hcl
data "terraform_remote_state" "storage" {
  backend = "s3"
  config = {
    bucket = var.state_bucket_name
    key    = "10-storage/terraform.tfstate"
    region = var.aws_region
  }
}
# 用 data.terraform_remote_state.storage.outputs.site_bucket_name
```

好处是「桶名只在 10-storage 里定义一次」，坏处是**上游改输出名会让下游 plan 失败**——
这反而是好事，总比悄悄用了旧值强。

*Layers read upstream outputs via `terraform_remote_state` rather than sharing state. Renaming
an output breaks the downstream plan — louder than silently using a stale value.*

### 4.4 首次执行顺序（只有第一次不一样）

1. **`00-bootstrap` 用本地 state 跑一次**（它要建的就是放 state 的桶，不可能先有桶）。
2. 把本地 `terraform.tfstate` 迁进刚建好的桶（改 backend 后 `terraform init -migrate-state`）。
3. 其余三层从一开始就用远端 state。
4. `20-edge` 是**导入**既有 CloudFront 分发，不是新建——所以 `prod.tfvars` 里的
   `oac_name` / `distribution_comment` / `http_version` 必须与线上**逐字一致**，否则 plan
   会显示「要重建」，那是断站。

### 4.5 日常姿势

```bash
cd layers/30-compute
terraform init -backend-config=backend.hcl
terraform plan -var-file=prod.tfvars      # 只读，随便跑
terraform apply -var-file=prod.tfvars     # 只有这一步会真改东西
```

在 CI 里，`plan` 的退出码有讲究：`-detailed-exitcode` 让 `0=无变更 / 1=出错 / 2=有变更`，
流水线据此决定要不要把差异贴到 Job Summary。

*In CI, `-detailed-exitcode` separates "no changes" (0) from "error" (1) and "changes pending" (2).*

---

## 5. Secrets 与 Variables 对照 / Secrets vs Variables

**Secrets 会打码、日志里显示 `***`；Variables 是明文，适合放标识符。** 判断标准只有一条：
泄漏了会不会直接导致别人能读写你的云资源。

### 5.1 `album`（应用仓库）

| 名字 | 类型 | 谁生成 | 谁读 | 说明 |
| --- | --- | --- | --- | --- |
| `AWS_APP_DEPLOY_ROLE_ARN` | Variable* | `terraform output`（bootstrap） | deploy-web、build-image | ARN 本身不是秘密 |
| `SITE_BUCKET` | Variable | 10-storage | deploy-web | 站点桶名 |
| `DISTRIBUTION_ID` | Variable | 20-edge | deploy-web | 失效 CDN 用 |
| `ALBUM_API_BASE` | Variable | 30-compute `api_endpoint` | deploy-web（构建期注入 `<meta name="album-api">`） | 空值时上传入口不出现 |
| `SITE_DOMAIN` | Variable | 自定 | deploy-web（摘要里显示地址） | `photos.chenyouyi.top` |

\* 两个 workflow 都写成 `vars.AWS_APP_DEPLOY_ROLE_ARN || secrets.AWS_APP_DEPLOY_ROLE_ARN`，
两处任填其一都能跑——这是被「填了 Variables 而工作流只读 Secrets」坑过一次之后加的双来源。

### 5.2 `album-infra`（基础设施仓库）

| 名字 | 类型 | 谁生成 | 说明 |
| --- | --- | --- | --- |
| `AWS_PLAN_ROLE_ARN` | Variable | bootstrap output | plan 用 |
| `AWS_APPLY_ROLE_ARN` | Variable | bootstrap output | apply 用 |
| `ALBUM_AUTH_PHONES` | **Secret** | 你 | 手机号白名单（存明文：11 位号码哈希挡不住穷举） |
| `ALBUM_SHARED_KEY_HASH` | **Secret** | `npm run hash-key` | 共享密钥的 scrypt 哈希 |
| `ALBUM_JWT_SECRET` | **Secret** | `openssl rand -base64 48` | 签发/校验访问令牌 |

后三项通过 `TF_VAR_*` 环境变量传给 Terraform，**永不落盘、永不进 state 明文之外的地方**
（`sensitive = true` 的变量在 plan 里也会打码）。

*The three secrets travel as `TF_VAR_*` env vars, never written to a file.*

### 5.3 为什么手机号白名单不做哈希

有人会想「白名单也哈希一下更安全」。对 11 位中国手机号没有意义：空间只有约 10¹¹，
拿到哈希后几分钟就能穷举完。存明文反而能直接核对，泄露风险由「SSM 参数只给这个函数读」
来控制。

---

## 6. 三条流水线 / The three workflows

### 6.1 `deploy-web.yml` —— 发前端

```
push main（且改了 src/web/** 等）
  → npm ci
  → npm run build:web         # --target=web：完全不读 photos/
  → npm run verify            # 36 项结构断言（含「产物里不该有照片」）
  → npm test
  → 守卫：dist/photos 若有文件 → 拒绝发布
  → 检查仓库配置（缺 Variable 就在这一步报清楚）
  → OIDC 换凭证
  → aws s3 sync dist/assets/ → s3://<site>/assets/ --delete --size-only（一年长缓存）
  → aws s3 cp dist/index.html → s3://<site>/index.html（no-cache）
  → cloudfront create-invalidation --paths /index.html
```

**最危险的一条规则**：`build:web` 的产物里没有 `photos/`，所以**任何对桶根的
`sync --delete` 都会把线上照片全删了**。这就是为什么同步按前缀分域：

| 前缀 | 谁写 | 发布时怎么处理 |
| --- | --- | --- |
| `assets/` | 前端流水线 | `sync --delete`（文件名带内容哈希，删旧的没副作用） |
| `index.html` | 前端流水线 | 单独 `cp`，`no-cache` |
| `photos/` | 处理函数 | **不碰** |
| `data/` | 处理函数 | **不碰** |

另一个坑：缓存头必须两段式。不能用 `--exclude` 把入口页排除在第一段之外——AWS CLI 的
`--exclude` 会连带影响 `--delete` 的判定，入口页会被当成「源站已不存在」删掉。

*Two-stage caching, and never `--exclude` the entry page: it changes how `--delete` decides,
and the entry page gets deleted as "no longer in source".*

### 6.2 `build-image.yml` —— 发处理镜像

```
push main（且改了 src/server/**）
  → npm test（服务端单测）
  → buildx build --platform linux/amd64 --provenance=false --sbom=false
  → push 到 ECR，tag = git 短 sha（12 位）
```

两个必须记住的点：

1. **必须 `provenance: false`**。buildx 默认给推送到仓库的镜像附加一份「构建证明」，
   产物于是变成一个 OCI **index**（真镜像 + 证明清单）。Lambda 只接受单平台的 image
   manifest，报错是 `The image manifest, config or layer media type ... is not supported`，
   完全没提 provenance。
2. **必须 `linux/amd64`**。本机是 Apple Silicon，本地 `docker build` 出的是 arm64，Lambda 起不来。
   所以镜像只在 ubuntu runner 上构建。

*`provenance: false` is mandatory: buildx otherwise turns the artifact into an OCI index that
Lambda rejects with an error that never mentions provenance.*

### 6.3 `infra.yml` —— 改基础设施

```
pull_request → lint + plan（每层一个矩阵任务）
push main    → lint + plan（只把差异摆出来，不 apply）
手动 dispatch → mode=apply + confirm=apply → lint → apply（四层串行，max-parallel: 1）
```

`max-parallel: 1` 不是保守，是必须：Terraform 不知道层与层之间的顺序，两层同时写 state 会坏。

*`max-parallel: 1` is required: Terraform has no idea about layer ordering, and two layers
writing state at once corrupts it.*

---

## 7. 两条真实路径 / Two real paths

**A. 改一行 CSS**

```
你 git push → deploy-web 跑（1~2 分钟）→ assets/ 换新哈希目录、index.html 重写
→ 失效 /index.html → 用户刷新即见
```
照片与清单完全没动。这就是「发布只更新代码」。

**B. 手机传一张照片**

```
App 选图 → 算 sha256 → POST /auth（手机号 + 共享密钥）→ token
→ POST /upload-url（带 sha256/大小/相册）→ 预签名 URL（元数据头进签名）
→ PUT 直传 s3://chenyouyi-source/incoming/<hash16>.jpg
→ S3 事件 → Lambda processor（sharp 三档 webp / ffmpeg 1080p）
→ 写 photos/<id>/ + 合并清单 + 条件写 data/version.json
→ 删除源桶原图
→ 失效 /data/version.json → 常驻页面 10 分钟内自动换新
```
实测 1600×1200 的照片端到端约 22 秒。**全程没有服务器常驻，也没有一次「重新部署前端」。**

*Measured end to end: presigned PUT returns 200, the photo is live ~22 s later, the source object
leaves no version behind, and a corrupt file lands in the DLQ after two retries. No always-on
server, and no frontend redeploy anywhere in the chain.*

---

## 8. 排错手册 / Troubleshooting

| 症状 | 根因 | 怎么确认 |
| --- | --- | --- |
| `Credentials could not be loaded` | `sub` 格式不匹配 | CloudTrail 里看实际 `sub`，两种格式都写 |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | 缺 `id-token: write` 权限或 `aud` 条件写错 | 看 workflow `permissions` |
| 上传 403 `headers not signed` | 预签名只传了 `signableHeaders`，没传 `unhoistableHeaders` | 解 URL 里的 `X-Amz-SignedHeaders` 是否含 `x-amz-meta-*` |
| Lambda `image manifest ... not supported` | 镜像被 buildx 加成 OCI index | `aws ecr describe-images` 看 mediaType |
| `reserved concurrency` 400 | 账号总并发只有 50，任何预留都会让非预留低于 50 | 去掉预留，改用代码里的条件写 |
| 部署「上传 0 / 删除 0」 | 产物名带内容哈希，同尺寸即同内容 | 这是对的，加 `--size-only` |
| 线上还是旧页面 | `deploy-web` 失败在守卫那一步 | Actions 里看是哪一步红的 |

---

## 9. 如果从零重搭一遍 / Rebuild from scratch

1. 建三个 GitHub 仓库，`album-infra` 设为**私有**。
2. 本机 `aws configure` 一个有管理员权限的 IAM 用户（只在 bootstrap 用）。
3. 写 `00-bootstrap`：状态桶 + OIDC provider + 三个角色，**先本地 state** 跑 apply。
4. 迁 state 进桶：改 `backend.hcl` → `terraform init -migrate-state`。
5. 把三个角色 ARN 填进两个仓库的 **Variables**，三个密钥填进 infra 的 **Secrets**。
6. 依次 `10-storage → 20-edge → 30-compute`。20-edge 要先导入既有分发（若没有既有分发则是新建）。
7. 应用仓库推一次代码：看到 `deploy-web` 绿了，说明 OIDC 那条边通了。
8. 改一次 `src/server/**`：看到 ECR 里出现新 tag，说明推镜像那条也通了。

**每一步都有对应的一条断言或一个 plan 差异可以验证，不要靠「看起来跑通了」。**

*Each step has one assertion or plan diff that proves it; never rely on "it looked fine".*

---

## 10. 术语速查 / Glossary

| 词 | 一句话 |
| --- | --- |
| OIDC provider | 告诉 AWS「GitHub 签的 JWT 我认」的那条登记 |
| Trust policy | 角色的「谁能扮演我」规则，写的是 `sub` 条件 |
| Permission policy | 扮演成功后「能做什么」 |
| `sub` claim | JWT 里描述「哪个仓库、哪个分支或环境」的字段 |
| `terraform_remote_state` | 下游层读上游层输出的方式 |
| `use_lockfile` | S3 后端的原生状态锁（条件写），替代 DynamoDB |
| 保护环境（environment） | GitHub 上的部署环境；一旦声明，`sub` 里的 ref 会被替换 |
| 预签名 URL | 把一个 PUT 权限签进 URL，客户端拿着它直传 S3，不经过后端 |
