# 03 · 怎么保障安全 / How Security Holds

> 安全不是「加了个登录」，而是**七道边界各自挡住一类事故**。这份文档逐道讲：
> 防什么、怎么实现、破了会怎样、怎么自查。最后有一张「如果泄露了会怎样」的演练表。
>
> *Security is not "we added a login". It is seven boundaries, each blocking a specific class
> of accident. For each: what it prevents, how it is built, what happens if it fails, how to
> verify it. A leak-drill table closes the file.*

---

## 1. 先定威胁模型 / The threat model first

### 1.1 资产 / What we are protecting

| 资产 / Asset | 泄露后果 / Impact if leaked | 现在的状态 |
| --- | --- | --- |
| 带 GPS 与序列号的原图 | 家庭住址、行程、设备可被推断 | 只在源桶停留几十秒，处理成功即删；版本控制关闭 |
| 手机号 | 骚扰、撞库 | SSM 里存明文但有白名单逻辑；日志只输出掩码前 6 位 |
| 共享密钥 | 陌生人可上传 | 只存 scrypt 哈希；客户端存 `EncryptedSharedPreferences` |
| AWS 账号的操作权 | 账单与数据全失 | 只通过 OIDC 换 1 小时凭证；三角色分离 |
| APK 签名私钥 | 可发布「官方」恶意更新 | 只在个人机器上，`keystore.properties` 不入库 |

*Originals with GPS live for seconds; the phone number sits behind an allowlist; the shared key
exists only as a scrypt hash; AWS access exists only as one-hour STS credentials; the signing
key never leaves the machine.*

### 1.2 对手分三档 / Three tiers of adversary

| 对手 / Adversary | 能力 / Capability | 主要防线 |
| --- | --- | --- |
| 随便逛逛的人 | 有浏览器，知道站点地址 | 上传需要手机号 + 密钥；内容已脱敏 |
| 会读公开仓库的人 | 知道仓库地址、能看到 workflow、能 fork 开 PR | OIDC `sub` 精确匹配；fork PR 拿不到 token |
| 拿到某个凭据的人 | 有 1 小时 STS 凭证 / 有令牌 / 有密钥 | 角色最小权限；令牌短寿；**没有一把钥匙能开全套** |

*Three tiers: a casual visitor, someone who can read the public repos and open PRs, and someone
who holds one credential. No single credential opens everything.*

---

## 2. 边界 B1 · 身份：CI 凭什么能碰云 / Identity

### 2.1 上一代做法为什么不行 / Why long-lived keys fail

把 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 存进 GitHub Secrets。问题不在会不会泄漏，
而在**它永远有效**：泄漏一次，攻击者可以在任何地方、任何时间用，而日志无法区分
「这是 CI」和「这是别人」。

*The problem with static keys is not leakage, it is permanence: once leaked they work forever,
from anywhere, and logs cannot tell CI from an intruder.*

### 2.2 OIDC 换了一个问题 / OIDC changes the question

每次 job 运行，GitHub 签一张 **JWT**：

```json
{
  "iss": "https://token.actions.githubusercontent.com",
  "aud": "sts.amazonaws.com",
  "sub": "repo:scott372199/album:ref:refs/heads/main",
  "ref": "refs/heads/main",
  "exp": 1765000000
}
```

workflow 写 `permissions: id-token: write` 才会签。然后
`aws-actions/configure-aws-credentials` 把它交给 STS：

```
POST https://sts.amazonaws.com/
Action=AssumeRoleWithWebIdentity
&RoleArn=arn:aws:iam::<ACCOUNT_ID>:role/album-gha-app-deploy
&WebIdentityToken=<JWT>
```

STS 做三步：验签（确实是 GitHub 签的）→ **比对 `sub` 是否匹配信任策略** → 发 1 小时凭证。

**所以真正的安全边界不是「密钥藏得深不深」，而是信任策略里那几行 `sub` 条件。**

*STS verifies the signature, then compares `sub` against the trust policy, then issues
one-hour credentials. The boundary is that string comparison.*

### 2.3 陌生人能不能自己签一张？ / Can a stranger mint one?

**不能。** 关键不是「他不知道密钥」，而是 **payload 的每一个字段都在签名覆盖范围内**。

```
JWT = base64(header) . base64(payload) . RSA-SHA256(header + "." + payload, GitHub 私钥)
```

- **他可以拿到 JWT，但只能拿到自己那张**：去自己的仓库跑一个带 `id-token: write` 的
  workflow，`sub` 是 `repo:他的用户名/他的仓库:...`。
- **他不能改 payload**：把 `sub` 改成 `repo:scott372199/album-infra:...`，签名立刻对不上，
  AWS 验签失败（`InvalidIdentityToken`）。
- **他不能用别人的 JWT**：那是 5 分钟寿命的一次性票据；换出来的凭证最长 1 小时。

AWS 侧是**两步**，缺一不可：验签（「这票是 GitHub 签的」）+ 比对 `sub`（「签给谁的」）。
陌生人那张票在第二步就被挡掉。

*No. Every claim is inside the signature, so a stranger can only obtain a token for their own
repository; editing the payload breaks the signature; a stolen token expires in five minutes.
AWS verifies the signature first, then compares `sub`. Public repos leak addresses, not keys.*

### 2.4 两种 `sub` 格式与 environment 陷阱 / Two shapes, one trap

```
repo:scott372199/album:ref:refs/heads/main                      ← 老仓库
repo:scott372199@175766495/album@1453810297:ref:refs/heads/main ← 新仓库（带数字 ID）
```

GitHub 正在给新旧仓库签发不同格式，只写一种就会 `AccessDenied`，而错误信息伪装成
`Credentials could not be loaded`，完全看不出是主体名对不上。本项目两种都认，数字 ID 用 `@*`。

第二个陷阱：**job 一旦声明 `environment: production`，`sub` 里的 `ref` 段会被换成
`environment:production`**。`deploy-web` 正好声明了 environment，所以那条边要同时列两种。

```hcl
app_subject    = "repo:${var.github_org}/${var.app_repo}"      # ...:ref:refs/heads/main
app_subject_id = "repo:${var.github_org}@*/${var.app_repo}@*"
# 再各配一条 ...:environment:production
```

*Both shapes must be listed, and declaring an environment replaces the ref segment — so that
variant must be listed too.*

### 2.5 真正危险的是把 `sub` 写宽 / The real footgun is a loose `sub`

| 写法 / Pattern | 后果 / Consequence |
| --- | --- |
| 只有 `aud`，没有 `sub` 条件 | **任何人的任何仓库**都能 assume，等于把角色公开 |
| `repo:scott372199/*` | 名下任何仓库（含以后随手建的测试仓库）都能 assume |
| `repo:scott372199/album*` | `album-evil`、`album-test` 也匹配 —— `*` 会吃掉 `/` 后面的字符 |
| 加上 `:pull_request` | PR 触发的工作流也能拿角色；配合 `pull_request_target` 就是灾难 |
| `StringLike` 配 `environment:*` | 任何环境名都行 |

本项目四个 `sub` 全部精确到分支名或环境名，没有一个能靠「猜一个 ref 名」命中。
另外 `StringEquals` / `StringLike` 是易错点：**只要用了 `*` 就必须 `StringLike`**，
用 `StringEquals` 会静默不匹配。

*All four subjects pin an exact branch or environment name. And the moment a wildcard appears,
the operator must be `StringLike`.*

### 2.6 GitHub 侧的两条硬约束 / Two hard constraints from GitHub

- **fork 来的 PR 拿不到 OIDC token**，即使 workflow 里写了 `id-token: write`。否则任何人对
  公开仓库开个 PR 就能以上游身份换云凭证。代价是「PR 里跑 plan」在公开仓库做不到。
  逃生口是 `pull_request_target`（能拿 token 也能拿 secrets），**本项目不使用**。
- **能触发 workflow 的人才可能拿到 token**。陌生人最多 fork 后开 PR，签出来的 `sub`
  是他自己的仓库名。

*Fork PRs cannot obtain OIDC tokens at all; the escape hatch `pull_request_target` is not used
here.*

---

## 3. 边界 B2 · 权限：五个角色，谁都不能开全套 / Authorization

| 角色 / Role | 能做什么 / Can | 明确不能 / Cannot |
| --- | --- | --- |
| `album-gha-app-deploy` | 站点桶 `Put/Delete/GetObject` + `ListBucket`；`cloudfront:CreateInvalidation`；ECR 推镜像 | 碰 state 桶、改 IAM、改 CloudFront 配置 |
| `album-gha-infra-plan` | `ReadOnlyAccess` + state 桶读写 + 拿锁 | 任何写操作 |
| `album-gha-infra-apply` | 基础设施全权 | ——（所以它只能手动触发） |
| `album-auth`（Lambda 执行角色） | 读三个 SSM 参数；写 `incoming/*`；读写限流表 | 读不到 `photos/`，删不了照片 |
| `album-processor` | 读源桶、读写站点桶、失效 CDN | 改 IAM、碰其他桶 |

两个设计意图：

1. **推镜像的权限给了「内容发布」角色**，不是「基础设施」角色。镜像由应用仓库的 CI 构建；
   若归 infra 角色，那「改一张图」的流水线就顺带拿到了改基础设施的能力。
2. **签地址的角色不该有删照片的能力**。`album-auth` 只能写 `incoming/*`，即便被完全控制，
   损失上限是「多了一些待处理的原图」。

*Image push belongs to the content role, because giving it to the infra role would hand infra
privileges to every image bump. And the role that signs upload URLs cannot delete photos.*

**一个容易漏的点**：预签名 URL 是**用 Lambda 自己的执行角色签的**，不是用调用者身份。
所以 `album-auth` 角色必须有 `s3:PutObject` 到 `incoming/*`，否则签出来的地址会被 S3 拒绝。

*Presigned URLs are signed with the function's own role, so that role needs `PutObject` on
`incoming/*`.*

---

## 4. 边界 B3 · 上传入口 / The upload entry point

上传是整套系统**唯一的写入口**，所以这一层叠了六道：

| 道 / Layer | 机制 / Mechanism | 挡什么 / Blocks |
| --- | --- | --- |
| ① 手机号白名单 | SSM 里的号码表，精确匹配 | 不知道号码的人 |
| ② 共享密钥 | 只存 scrypt 哈希；比对用 `timingSafeEqual` | 知道号码但没有密钥的人 |
| ③ 失败限流 | DynamoDB 计数 + TTL，5 次锁 15 分钟 | 撞库与穷举 |
| ④ 令牌 | HS256，1 小时；`sub` 是手机号哈希；只走 `Authorization` 头 | 免登录调用 |
| ⑤ 预签名约束 | 15 分钟、`Content-Type` 进签名、key 固定前缀与形状 | 改成上传 HTML、越界写其他前缀 |
| ⑥ 合并校验 | `key` 形状 + `incoming/` 前缀、`etag` 形状、片号 1..10000、升序 | 伪造 key 写进 `photos/` 或构造畸形合并 |

补充三个细节：

- **三条登录校验任一失败都返回同一个 `invalid_credentials`**，不告诉对方是号码错还是密钥错。
- **手机号白名单不做哈希**：11 位号码空间只有约 10¹¹，拿到哈希几分钟就能穷举完，存明文
  反而能直接核对；风险由「SSM 参数只给这个函数读」控制。
- **体积与数量在服务端校验**（单次 ≤20 个、图片 ≤30MB、视频 ≤200MB），前端限制只是体验。

*Six layers on the only write entrance: allowlist, shared key, rate limit, token, presigned
constraints, completion validation. Any credential failure returns the same error code.*

---

## 5. 边界 B4 · 内容：脱敏是隐私的唯一防线 / Redaction

**关键认知：站点是公开的。**「私有桶」和「私有仓库」都不是访问控制——任何拿到 URL 的人
都能看照片。所以隐私不能靠「藏」，只能靠「里面本来就没有敏感信息」。

*The site is public. A private bucket is not access control — anyone with a URL can read a
photo. Privacy therefore cannot rely on hiding, only on the bytes containing nothing sensitive.*

| 控制点 / Control | 实现 / Implementation |
| --- | --- |
| 图片 | `sharp` 重编码为 webp，**不调用 `.withMetadata()`** 即剥离 EXIF；输出后再断言「没有 exif」 |
| 视频 | 先 `ffprobe` 取 `creation_time` 算年月，再 `-map_metadata -1` 清空容器与流元数据，`-fflags +bitexact` |
| 清单字段 | 白名单：`id / album / year / month / ratio / tags / title / caption / 路径`。GPS、机型、序列号、**原始文件名**、精确拍摄时刻一律不写 |
| 原图 | 处理成功后立即删源对象；生命周期 30 天只作兜底（失败残留） |
| 源桶版本控制 | **关闭**。开了版本控制，`DeleteObject` 只写删除标记，原图作为历史版本仍在——「删了」是错觉 |
| 年月精度 | 只保留年月，不保留时分秒 |

*Re-encode without metadata, strip video containers after probing the date, whitelist manifest
fields, delete originals immediately, and keep versioning off so deletion is real.*

三条相关取舍：

- 视频顺序不能反：先清元数据再取年月，年月就没了。
- 关版本控制的代价是**无法恢复误删**；但对象键是内容哈希，不存在覆盖问题，且源桶本就不承担
  备份职责（灾后重建靠重新导入）。
- `takenAt` 由客户端提供，理论上可伪造；影响仅限「年月归到别的月份」，不泄露任何东西。

*Trade-offs: probe before stripping; no undelete on the source bucket; a forged `takenAt` only
misplaces a month.*

---

## 6. 边界 B5 · 网络与存储 / Network and storage

```
浏览器 ──HTTPS──▶ CloudFront ──SigV4(OAC)──▶ S3 REST（私有）
   ▲                    │
   └─ 直连 S3 website 端点 / REST 端点 ──▶ 403
```

| 控制 / Control | 状态 |
| --- | --- |
| 桶私有 + Public Access Block 四项全开 | 三个桶全部 |
| 桶策略 | `Principal = cloudfront.amazonaws.com` + `Condition AWS:SourceArn = 本分发 ARN` |
| 直连 S3 REST | 403（已列为验收项） |
| 旧 S3 website 端点 | 已下线（404） |
| HTTP → HTTPS | CloudFront 强制 301 |
| 混合内容 | 壳里 `MIXED_CONTENT_NEVER_ALLOW`；构建时断言产物里没有 `http://` |
| 证书 | ACM 自动续期；Terraform 用 `data` 引用、**不进 state**，免得被误替换 |
| CORS | 源桶只允许站点源 + `PUT`，`ExposeHeaders: ETag`；API Gateway 侧统一加头 |

**没有 WAF，也没有 Shield Advanced**，这是刻意省下的：上传入口有令牌 + 限流 + 白名单，
静态站点走 CDN 本身有容量吸收；这两项的成本与这套系统的风险不成比例。

*No WAF, no Shield Advanced — deliberate. The write path already needs a token, a rate limit
and an allowlist, and the read path is a CDN.*

---

## 7. 边界 B6 · 供应链 / Supply chain

| 面 / Surface | 控制 / Control |
| --- | --- |
| 前端依赖 | **零**。没有第三方 JS，也就没有前端供应链风险 |
| 构建依赖 | 只有 `sharp` + `exifr`，锁文件入库，`npm ci` 安装 |
| 服务端依赖 | 独立 `src/server/package.json`，镜像里只装这一份 |
| 镜像来源 | Lambda 只能拉 ECR；ECR 是 `IMMUTABLE`，同一个 tag 推第二次被拒 |
| 镜像内容 | `node:22-bookworm-slim` + `apt ffmpeg`；不用官方 Lambda 镜像（无 ffmpeg）、不用 `aws-lambda-ric`（要原生编译） |
| APK | 签名私钥只在本机；下载后客户端校验 `sha256` 再调安装器 |
| 仓库安检 | `npm run check:repo` 拦媒体文件、密钥形状、大文件、绝对路径（81 个文件） |
| Actions | 只用官方与 `aws-actions/*`，主版本固定 |

*Zero frontend dependencies, immutable image tags, no Lambda base image surprises, a signing
key that never leaves the machine, and a repo check that blocks media and key-shaped strings.*

---

## 8. 边界 B7 · 仓库与凭据 / Repos and credentials

| 仓库 / Repo | 可见性 | 里面没有的东西 |
| --- | --- | --- |
| `album` | 公开 | 无长期密钥、无 state、无照片、无账号 ID（用 `<ACCOUNT_ID>` 占位） |
| `album-infra` | **私有** | 无 state 文件、无 tfvars 里的真实密钥（走 `TF_VAR_*`） |
| `album-android` | 公开 | 无 keystore、无 `keystore.properties`、无口令 |

### 8.1 Secrets 与 Variables 的判断标准 / Secrets vs variables

只有一条：**泄漏了会不会直接导致别人能读写你的云资源**。

| 名字 / Name | 类型 | 谁生成 | 谁读 |
| --- | --- | --- | --- |
| `AWS_APP_DEPLOY_ROLE_ARN` | Variable | bootstrap output | 两条应用流水线 |
| `SITE_BUCKET` / `DISTRIBUTION_ID` / `SITE_DOMAIN` | Variable | storage / edge | `deploy-web` |
| `ALBUM_API_BASE` | Variable | compute `api_endpoint` | `deploy-web`（构建期注入 `<meta>`） |
| `AWS_PLAN_ROLE_ARN` / `AWS_APPLY_ROLE_ARN` | Variable | bootstrap output | infra 流水线 |
| `ALBUM_AUTH_PHONES` | **Secret** | 你 | infra apply（`TF_VAR_*`） |
| `ALBUM_SHARED_KEY_HASH` | **Secret** | `npm run hash-key` | 同上 |
| `ALBUM_JWT_SECRET` | **Secret** | `openssl rand -base64 48` | 同上 |

三个 Secret 通过 `TF_VAR_*` 环境变量进入 Terraform，**永不落盘**；`sensitive = true` 让它们
在 plan 里也打码。角色 ARN 放 Variable 是安全的：**没有匹配信任策略的 ARN 毫无用处**。

*Role ARNs are harmless without a matching trust policy; the three real secrets only ever travel
as `TF_VAR_*` environment variables.*

### 8.2 密钥全景 / Where every secret lives

| 密钥 / Secret | 存放 / Stored in | 谁读 / Read by | 轮换 / Rotation |
| --- | --- | --- | --- |
| 手机号白名单 | SSM SecureString | `album-auth` | 改参数 + 重启（下一次冷启动生效） |
| 共享密钥 | scrypt 哈希在 SSM | `album-auth` | `npm run hash-key` 重算 → 更新参数 → App 重新输入 |
| JWT 密钥 | SSM SecureString | `album-auth` | 换参数即让所有旧令牌失效 |
| AWS 访问权 | 无长期凭证 | —— | 不适用 |
| APK 签名私钥 | 本机 + 离线备份 | 本机 Gradle | 换密钥意味着必须卸载重装 |

*Every secret has one home, one reader, and a written rotation path.*

---

## 9. 演练：如果…会怎样 / Leak drills

| 假设 / If | 后果 / Consequence | 处置 / Response |
| --- | --- | --- |
| 公开仓库被人 fork 并提 PR | 拿不到 OIDC token；PR 里的 workflow 跑在他自己的 fork | 无需动作 |
| 有人拿到 `AWS_APP_DEPLOY_ROLE_ARN` | ARN 不是钥匙，`sub` 不匹配就没用 | 无需动作 |
| 有人拿到 1 小时 STS 凭证 | 能改 `assets/` 与 `index.html`、能推镜像 tag | 等 1 小时自然失效；查 CloudTrail 定位；`git revert` + 重发 |
| 有人拿到 APK | 只能装，签不了新的 | 无需动作（除非私钥也泄露） |
| **APK 私钥泄露** | 可发「官方」恶意更新 | 立刻换 keystore、提高 versionCode，让所有人卸载重装；旧密钥无法吊销 |
| 手机号泄露 | 可被骚扰 | 号码表在 SSM，改参数即可移除 |
| 共享密钥泄露 | 陌生人可上传 | 重跑 `hash-key` → 更新 SSM → App 重新输入；旧令牌一小时后失效 |
| **JWT 密钥泄露** | 可伪造任何人的令牌（但 `sub` 只是手机号哈希，无法越权） | 换 SSM 参数 → 全部令牌立即失效 |
| 桶策略写宽（`Principal: *`） | 站点桶被公开列举与下载 | `terraform plan` 应看出差异；`curl` 直连应回 403 |
| 有人改了 `sub` 条件 | 角色可能被别的仓库 assume | 信任策略在 00-bootstrap，改动必须走 apply；`make check` 有断言 |
| 云端账号被完全接管 | 全失 | 这是唯一没有技术解的情形，靠账号本身的 MFA 与 root 邮箱 |

*Threat drills from harmless (fork PR) to fatal (account takeover, which only MFA and a
protected root mailbox mitigate).*

---

## 10. 残余风险：明确接受的部分 / Accepted residual risk

| 风险 / Risk | 为什么接受 / Why accepted |
| --- | --- |
| 站点公开，任何人可看全部照片 | 这是产品定义；隐私靠脱敏，不靠门禁 |
| 共享密钥是「一个密码给所有设备」 | 单人使用场景；换密钥成本低（一次 SSM 更新） |
| 手机号即第一因子 | 没有短信通道，也不想要；白名单 + 限流已足够挡撞库 |
| 单账号、单区域 | 多账号隔离的成本远高于收益 |
| 无 WAF / 无 Shield | 写入口已有令牌与限流；读路径在 CDN 后面 |
| 源桶不承担备份 | 换取「原图不在云上留存」；备份在本机与离线盘 |
| `takenAt` 可被伪造 | 只影响年月归类，不泄露信息 |
| 私有仓库没有审批门 | 用「合并只 plan、apply 手动 + 二次确认」替代 |

*Each accepted risk has a stated reason; the list exists so nobody later mistakes an accepted
trade-off for an oversight.*

---

## 11. 上线前自检 / Pre-flight checks

```bash
# 1. 直连 S3 必须 403，正式域名必须 200
curl -o /dev/null -s -w '%{http_code}\n' https://chenyouyi.s3.ap-southeast-1.amazonaws.com/index.html
curl -o /dev/null -s -w '%{http_code}\n' https://photos.chenyouyi.top/

# 2. 产物里没有任何 http:// 引用（混合内容）
npm run verify

# 3. 仓库里没有媒体、密钥形状、大文件、绝对路径
npm run check:repo

# 4. 清单里没有敏感字段
curl -s https://photos.chenyouyi.top/data/version.json

# 5. 信任策略与桶策略的形状（离线断言，不连 AWS）
cd ../album-infra && make check

# 6. 四层计划为零差异（说明没人手工改过云端）
make plan layer=10-storage && make plan layer=20-edge && make plan layer=30-compute
```

**判断标准不是「看起来对」，而是每条都有一个可以贴出来的输出。**

*The standard is not "it looked right" — every line above produces output you can paste.*
