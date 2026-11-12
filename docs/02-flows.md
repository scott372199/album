# 02 · 它们怎么联动 / How the Pieces Move Together

> 这份文档只回答一个问题：**某个动作发生之后，谁被叫醒、拿到什么、写到哪、失败了怎么办。**
> 五条流：读一张照片、传一张照片、传一个视频、发前端代码、改基础设施。
>
> *This file answers one question: after something happens, who wakes up, what do they get,
> where does it go, and what happens when it fails. Five flows: read a photo, upload a photo,
> upload a video, ship frontend code, change infrastructure.*

---

## 1. 全局：三条互不重叠的写路径 / Three write paths that never overlap

| 谁在写 / Writer | 写哪个前缀 / Prefixes | 触发 / Trigger |
| --- | --- | --- |
| 发布流水线（`deploy-web`） | `assets/`、`index.html` | 推 `main` |
| 处理函数（`album-processor`） | `photos/<id>/`、`data/` | S3 事件 |
| 本机发布脚本 | `chenyouyi-downloads/apk/` | 手动跑 |

**这是整套系统最要紧的一条边界**：`build:web` 的产物里没有 `photos/`，所以任何对桶根的
`sync --delete` 都会把线上照片全部删掉。流水线按前缀分域，并且有一道守卫直接拦。

*The crux of the whole system: the web bundle contains no `photos/`, so a root-level
`sync --delete` would wipe every photo. Deploys are prefix-scoped and guarded.*

---

## 2. 流 A：打开页面看照片 / Reading a page

```
浏览器                         CloudFront                     S3 站点桶
  │ GET /                          │                              │
  ├───────────────────────────────▶│ 未命中 → OAC 签名回源 ────────▶│ index.html
  │◀── 200 text/html, no-cache ────┤                              │
  │ 解析 → GET assets/js.<h>/app.js│                              │
  ├───────────────────────────────▶│ 命中（一年 immutable）────────▶│
  │ GET data/version.json          │                              │
  ├───────────────────────────────▶│ 命中（no-store 只在浏览器侧）──▶│
  │◀── { rev, manifest } ──────────┤                              │
  │ GET data/manifest.<rev>.json   │                              │
  ├───────────────────────────────▶│ 命中（一年 immutable）────────▶│
  │ GET photos/<id>/thumb.webp…    │                              │
  └───────────────────────────────▶│ ────────────────────────────▶│
```

三件事值得注意：

1. **首屏只有 4 类请求**：入口页、一个 JS 目录、指针文件、清单；图片按 `srcset` 与懒加载
   分批来。
2. **缓存策略是分层的**：入口页每次都问（换来「发布即生效」），其余永不问（换来「零回源」）。
3. **不需要登录**。站点是公开的——私有桶不是访问控制手段，真正的防线是内容脱敏（见 03 §4）。

*Four request classes on first paint; layered caching; no login anywhere on the read path.
The bucket being private is not access control — redaction is.*

---

## 3. 流 B：传一张照片 / Uploading one photo

### 3.1 时序 / Sequence

```
App/页面          API Gateway        album-auth        源桶 S3       album-processor   站点桶
   │                   │                 │                │                │            │
   │ ① 选图 → 读进内存（blob）           │                │                │            │
   │ ② 算 SHA-256（逐片，不整块进内存）  │                │                │            │
   │ ③ POST /auth {phone,key}           │                │                │            │
   ├──────────────────▶│────────────────▶│ 查 SSM 白名单、验证 scrypt、查限流表         │
   │◀── token(1h) + refresh(7d) ────────┤                │                │            │
   │ ④ POST /upload-url {album,files[]} │                │                │            │
   ├──────────────────▶│────────────────▶│ 校验体积/数量/形状，算 key，签地址            │
   │◀── items[{key,url}] 或 {multipart,uploadId,partSize,parts[]} ────────┤            │
   │ ⑤ PUT 直传（每片 8MB，不经网关）    │                │                │            │
   ├────────────────────────────────────────────────────▶│                │            │
   │◀── 200 + ETag ─────────────────────────────────────┤                │            │
   │ ⑥ POST /upload-complete {key,uploadId,parts:[etag]}│                │            │
   ├──────────────────▶│────────────────▶│ CompleteMultipartUpload ───────▶│            │
   │◀── 200 ────────────────────────────┤                │                │            │
   │                   │                 │   ⑦ ObjectCreated(incoming/) ──▶│            │
   │                   │                 │                │ 下载原图 → 三档 webp / 转码 │
   │                   │                 │                │ 合并清单 → 写产物 ─────────▶│
   │                   │                 │                │ 失效 /data/version.json    │
   │                   │                 │                │ 删除原图 ──────▶│            │
   │ ⑧ 下次刷新/轮询 → 新 rev → 新清单 → 看到照片                        │            │
```

### 3.2 每一步的契约 / Contract per hop

| 步 / Step | 事实 / Fact |
| --- | --- |
| ① 选图 | 壳通过 `onShowFileChooser` 交回 `content://` URI；页面把每个文件读成 `Blob` |
| ② 哈希 | 用 `crypto.subtle.digest` 分片累加，避免整块进内存；结果前 16 位即对象名 |
| ③ 登录 | 手机号 + 共享密钥。三条校验（白名单 → 密钥哈希 → 失败次数）任一不过都返回同一个 `invalid_credentials`，不区分原因 |
| ④ 取地址 | 单文件 ≤30MB 走单 PUT；>16MB 走分段。预签名 15 分钟，`Content-Type` 进签名 |
| ⑤ 直传 | 每片 8MB，`Content-Type` 与签名一致，**不带自定义头**（简单请求，无预检） |
| ⑥ 合并 | 服务端校验 `key` 形状与前缀、`etag` 形状、片号范围后调 `CompleteMultipartUpload` |
| ⑦ 处理 | 图片出 320/768/2048 三档 webp；不调 `withMetadata()` 即剥离 EXIF，并断言输出无 EXIF |
| ⑧ 上线 | 写 `data/manifest.<rev>.json` + 更新 `data/version.json`（`If-Match` 条件写）→ 失效指针 |

*Each hop's contract in one line: hashing is chunked, presigned URLs live 15 minutes, parts are
8 MB with no custom headers, completion is validated server-side, and publishing is a
conditional write on the pointer file.*

### 3.3 为什么大文件必须分片 / Why large files must be sliced

| 单请求直传 / Single PUT | 8MB 分片 / Multipart |
| --- | --- |
| 一次跨境长连接要撑住整个文件 | 每片独立连接，失败只重传 8MB |
| 手机切网、锁屏、后台 30 秒即断 | 单片超时按体积给（`60s + 3s/MB`，封顶 480s） |
| 200MB 视频几乎必然失败 | 每片重试 3 次（1.2s / 3.5s / 8s），每次重取预签名地址 |
| 一个 ETag，无中间状态 | 有分片清单，可续（当前实现是整文件重试，但不再受体积夹击） |

另外一条硬约束来自壳：`allowContentAccess = false` 让 `xhr.send(File)` 拿不到
`content://` 背后的文件描述符，请求以 0 字节立即失败。**先 `slice().arrayBuffer()` 读进内存
再发**是唯一稳的路径。

*A single cross-border PUT has to survive the whole file; slicing makes a failure cost 8 MB.
And because the shell disables content access, a `File` handed to XHR fails at zero bytes —
reading the slice into memory first is the only reliable path.*

### 3.4 为什么合并必须在服务端做 / Why completion is server-side

`CompleteMultipartUpload` 的请求体是 XML，而浏览器能做的只有「往一个预签名 URL 发请求」，
无法给这个 XML 请求体签名。所以客户端只负责把每片的 ETag 收集起来交给
`POST /upload-complete`，由持有执行角色的函数去合并。

*The complete call carries an XML body that cannot be signed from the browser, so the client
hands its ETags to the function, which completes using its own role.*

### 3.5 去重与幂等 / Dedup and idempotency

- 对象名 = `sha256(内容)` 前 16 位 + 原扩展名。同一张照片传两次，是**同一个 key**，覆盖无副作用。
- 处理函数入口再算一次 SHA-256，若站点桶已有同 id 产物 → 直接结束。
- 清单写入用 `If-Match`；冲突返回 412 后重读重合并，不会静默丢条目。

*Keys are content hashes, so re-uploading is a no-op; the processor short-circuits on existing
outputs; manifest writes are conditional and retried on 412.*

---

## 4. 流 C：传一个视频 / Uploading a video

与照片同样的 8 步，差异集中在 ⑦：

| 差异 / Difference | 具体 / Detail |
| --- | --- |
| 体积 | 单视频上限 200MB，通常必然走分段（>16MB） |
| 年月来源 | **先** `ffprobe` 取 `creation_time` 算年月，**再** `-map_metadata -1` 清空元数据；顺序反了年月一起没了 |
| 转码 | H.264 / 1080p（短边上限）/ ≤30s / crf23，`-fflags +bitexact` 保证可重复 |
| 封面 | 抽一帧转 `poster.webp`，清单里带 `ratio` 让布局能算行高 |
| 超时 | 900s + `/tmp` 4GB；超过 15 分钟直接放弃并记录，只留封面 |
| 实测 | 137KB / 6s / 720p 素材，端到端 28s，其中函数本身 26.3s |

*Same eight steps; the differences live in step seven — probe before stripping metadata,
1080p/30 s re-encode, a poster frame, and a 900-second ceiling.*

---

## 5. 流 D：照片墙与故事模式 / Wall and story modes

这两条流**没有后端**：前端拿同一份清单，在浏览器里推进。

- 照片墙：全屏轮播，时钟 + 22:00–07:00 自动调光，静止 3 秒隐藏控制条；
  App 内通过桥调 `setKeepScreenOn`，浏览器内用 Wake Lock。
- 热更新：轮询 `data/version.json`，`rev` 变了就重拉清单——所以墙上会自己出现新照片。
- 故事模式：全屏逐张推进，节奏可调，键盘/触摸都能翻。

*Both are pure frontend on the same manifest. The wall polls the pointer file, which is how an
always-on iPad picks up new uploads without a reload.*

---

## 6. 流 E：改前端代码 / Shipping frontend code

### 6.1 流水线 `deploy-web`

```
push main（且改了 src/web/** | src/build/** | src/server/** | site.json | package*.json）
  ├─ concurrency: deploy-web（不取消在跑的：并发 sync 会互相删产物）
  ├─ npm ci
  ├─ npm run build:web       # 完全不读 photos/
  ├─ npm run verify          # 38 项结构断言
  ├─ npm test                # 64 项单测
  ├─ 守卫：dist/photos 若有文件 → 拒绝发布（说明跑成了全量构建）
  ├─ 检查仓库配置（缺 SITE_BUCKET / DISTRIBUTION_ID / ROLE_ARN 就地报清楚）
  ├─ OIDC → album-gha-app-deploy（1 小时）
  ├─ aws s3 sync dist/assets/ s3://<site>/assets/ --delete --size-only
  │       --cache-control "public, max-age=31536000, immutable"
  ├─ aws s3 cp dist/index.html s3://<site>/index.html --cache-control "no-cache, must-revalidate"
  ├─ aws cloudfront create-invalidation --paths "/index.html"
  └─ Summary：碰了哪些前缀、没碰哪些
```

### 6.2 四个必须这么写的理由 / Four non-negotiable details

| 细节 / Detail | 不这么做会怎样 |
| --- | --- |
| 不对桶根 `sync` | `--delete` 会把 `photos/` 与 `data/` 全删掉 |
| 缓存头两段式 | 不能靠 `--exclude` 把入口页排除在第一段外：`--exclude` 会连带影响 `--delete` 的判定，入口页被当成「源站已不存在」删掉 |
| 带 `--size-only` | 产物名带内容哈希，同尺寸即同内容；不加会把没变的文件每轮重传一遍 |
| 只失效 `/index.html` | 照片更新由处理函数负责失效 `data/version.json`；发布代码不该打整站 |

*Root-level sync wipes photos; `--exclude` breaks `--delete` decisions; without `--size-only`
every build re-uploads everything; invalidating only the entry page keeps the two writers
independent.*

### 6.3 用户怎么看到新版本 / How a user sees it

1. 下次打开/刷新 → 新版 `index.html`（`no-cache`，每次都问）。
2. App 内 WebView 进程不会自己换 bundle → **杀掉 App 重开**。
3. 常驻页面（照片墙）只轮询 `version.json`，所以它只会在内容变动时更新，不会换代码。

*Reopen the page for new HTML; kill the app for a new bundle inside the WebView; a resident
wall page only refreshes content, never code.*

---

## 7. 流 F：改服务端代码 / Shipping backend code

```
push main（且改了 src/server/** | docker/**）
  ├─ job test：npm test（64 项，纯函数，不装依赖也能跑）
  └─ job image：OIDC → ECR 登录
       ├─ 若 album-processor:<sha12> 已存在 → 整段跳过（ECR 是 IMMUTABLE，重跑不红）
       ├─ buildx --platform linux/amd64 --provenance=false --sbom=false
       ├─ push 到 ECR，tag = git 短 sha
       └─ Summary：打出 `-var image_tag=<tag>`，apply 时直接抄
```

**镜像标签变了不等于线上变了**。要让 Lambda 用上新镜像，必须去 infra 仓库手动：

```
cd layers/30-compute
# 改 prod.tfvars 的 image_tag
terraform plan  -var-file=prod.tfvars   # 应看到两个函数 in-place 更新
terraform apply -var-file=prod.tfvars
```

这是一条刻意的断点：**代码流水线永远不碰基础设施**。推一次代码最多产出一个新镜像，
线上换不换由人决定。

*A new tag does not change production. Deploying the image is a separate, manual Terraform
step — code pipelines never touch infrastructure.*

---

## 8. 流 G：改基础设施 / Changing infrastructure

```
album-infra 推 main / 开 PR
  └─ job lint：terraform fmt -check + validate（四层）
  └─ job plan：动态矩阵 [00-bootstrap, 10-storage, 20-edge, 30-compute]
        ├─ OIDC → album-gha-infra-plan（只读 + 能读写 state）
        ├─ terraform plan -detailed-exitcode
        │     0 = 无差异 / 2 = 有差异（贴到 Summary）/ 1 = 出错
        └─ 合并 main 也只到这一步

手动 dispatch（mode=apply，confirm 框里再打一次 "apply"）
  └─ OIDC → album-gha-infra-apply（可写）
  └─ apply 四层 max-parallel: 1（层间顺序只有人知道，Terraform 不知道）
```

三个设计点：

1. **合并永不写**。`apply` 必须人工 dispatch 并二次确认，因为私有仓库用不了
   required reviewers。
2. **`max-parallel: 1`**。两层同时写不同 state 文件本身不冲突，但下游依赖上游输出，
   并行会让下游读到上一轮的输出。
3. **动态矩阵**。job 级 `if` 拿不到 `matrix`（matrix 在其后求值），所以「只跑某一层」
   必须写成 `fromJSON(...)` 把矩阵算出来，而不是在 job 上写条件。

*Merging only plans. Apply is a manual dispatch with a second confirmation. Layers run
serially because ordering lives in a human's head, not in Terraform.*

---

## 9. 流 H：发一个 APK / Publishing an APK

```
本机  ./gradlew assembleRelease            # 签名只在本机
      node scripts/publish-apk.mjs
        ├─ 读 app/version.properties 的 versionCode/versionName
        ├─ 传 apk/album-<versionCode>.apk（内容不变，长缓存）
        ├─ 覆盖 apk/version.json（短缓存，客户端只读这一个）
        └─ 打印校验用的 sha256
App   页面加载完 → GET /apk/version.json → 比 versionCode → 下载 → 校验 sha256 → 安装
```

`versionCode` 只在 `app/version.properties` 里写一次，Gradle 与发布脚本都读它。
keystore、口令、`keystore.properties` 都不入库——这是安卓没有 CI 的唯一原因。

*One version file, two consumers. The keystore never enters a repo or a pipeline, which is the
only reason Android has no CI.*

### 9.1 能不能让 GitHub 跑 gradlew？ / Could CI build the APK?

**技术上完全能。** `ubuntu-latest` 就是安卓 CI 的标准环境：cmdline-tools、platform-tools、
build-tools 36、platforms android-36、NDK 全预装，`ANDROID_HOME` 已设，JDK 17/21 都在；
公开仓库还免费不限额（4 vCPU / 16 GB）。所以拦住我们的从来不是能力，是**签名私钥**。

| 方案 / Option | 做法 / How | 代价 / Cost |
| --- | --- | --- |
| **A. 只验证能编** | `./gradlew assembleDebug` + `scripts/check.mjs` 8 项自检 + 上传 artifact；正式包仍本机签 | 零密钥风险；多一条流水线维护，收益仅「换台机器也能确认没编坏」 |
| **B. CI 出未签名包** | `assembleRelease` 去掉签名 → artifact → 本机 `apksigner` | 跨机器搬文件，比现在更慢 |
| **C. keystore 进 Secrets** | base64 存 `UPLOAD_KEYSTORE_B64` + 三个口令，用 `-Pandroid.injected.signing.*` 注入 | 任何能改 workflow 的人都能把密钥带走；**密钥换不了**（一换所有人卸载重装） |

还有一条既有行为会让 A 之外的方案直接失败：构建脚本在找不到 keystore 时**故意报错**，
不回退 debug 签名（debug 签的包以后无法覆盖升级）。所以 CI 里 `assembleRelease` 必然红。

**当前结论：不加。** 本机发布是「`assembleRelease` + `publish-apk.mjs`」两条命令、一分钟内
完成，比等 CI 排队快；加 CI 唯一真实的收益是「不在本机时也能发版」，而那恰恰是方案 A
解决不了的（A 不发版）。真需要时按 A 做。

*Feasible in principle — the runner ships the whole Android toolchain — but the blocker is the
signing key, and no option makes publishing both keyless and convenient. The local two-command
flow wins; option A is the fallback if CI verification is ever wanted.*

---

## 10. 四条不变量 / Four invariants

1. **前缀归属**：`assets/` + `index.html` 只由发布流水线写；`photos/` + `data/` 只由处理函数写；
   `apk/` 只由本机脚本写。跨界即事故。
2. **清单是唯一真相**：页面渲染只看 `manifest.<rev>.json`；`version.json` 只是指针。
3. **内容哈希即幂等**：对象名来自内容，重传/重跑都是覆盖，不需要清理逻辑。
4. **凭证永不过夜**：CI 没有长期密钥，令牌 1 小时，预签名 15 分钟，STS 1 小时。

*Prefix ownership, manifest as the single source of truth, content-hash idempotency, and no
credential that outlives the hour.*

---

## 11. 失败矩阵 / Failure matrix

| 失败点 / Where | 现象 / Symptom | 系统行为 / What happens | 恢复 / Recovery |
| --- | --- | --- | --- |
| 单片上传失败 | `连接中断（已重试 3 次）· 第 7/19 片 · 已发 42%` | 该片重试 3 次（每次重取预签名）；仍失败则该文件标记失败，其他文件继续 | 点「重试失败项」 |
| 预签名过期 | 403 | 下一次重试会重新取地址 | 自动 |
| 登录失败 | `invalid_credentials` | 失败计数 +1，5 次后锁 15 分钟（DynamoDB TTL） | 等窗口过期 |
| 上传成功但没上线 | 清单里没有 | 可能进了 DLQ；源对象 30 天后由生命周期清掉 | 看 `album-processor-dlq` 与日志 |
| 处理失败 | 站点上不出现 | 异步重试 2 次 → DLQ；**原图保留**供排查 | 修完重放消息 |
| 视频超 15 分钟 | 只有封面 | 直接放弃并记录 | 手工处理 |
| 清单写冲突 | 412 | 重读重合并 | 自动 |
| CDN 还返回旧页 | 页面没变 | 入口页 `no-cache` 但边缘可能仍有副本 | 失效 `/index.html`（秒级生效） |
| OIDC 报 `Credentials could not be loaded` | CI 红 | 十有八九是 `sub` 格式不匹配 | 见 03 §2.4 |

*Every failure has a defined sink: retries with fresh presigned URLs, a DLQ with the original
preserved, conditional manifest writes, and a single targeted invalidation.*

---

## 12. 实测时间线 / Measured timelines

| 场景 / Scenario | 实测 / Measured |
| --- | --- |
| 照片端到端（上传完成 → 站点可见） | 约 22 秒（1600×1200） |
| 视频端到端（137KB / 6s / 720p） | 28 秒，函数本身 26.3 秒 |
| 前端发布 | 1~2 分钟（含 verify + test） |
| 镜像构建 | 3~5 分钟（有 buildx 缓存时更快） |
| 单层 `terraform plan` | 10~12 秒（无差异时） |

*Photos ~22 s end to end, video ~28 s, frontend deploy 1–2 min, a layer plan 10–12 s.*

---

## 附录 A · 排错表 / Troubleshooting

| 症状 / Symptom | 先看这里 / Check first |
| --- | --- |
| 线上还是旧页面 | `deploy-web` 是否真绿；`index.html` 的 `cache-control` 是不是 `no-cache`；失效是否执行 |
| 照片传完不出现 | `album-processor-dlq` → CloudWatch 日志 → 源对象是否还在 |
| 大视频传不上去 / 选多个只进来一个 | WebView 拿不到 `content://` 描述符：上传必须走分片 + `slice().arrayBuffer()` |
| `POST /upload-complete` 回 400 | `invalid_key`（不在 `incoming/` 或形状不对）/ `invalid_etag`（源桶 CORS 的 `ExposeHeaders` 必须含 `ETag`） |
| 上传 403 `headers not signed` | 预签名要同时传 `signableHeaders` 与 `unhoistableHeaders` |
| CI 里 `terraform init` 卡住 | 本地沙箱会拦 `.terraform.lock.hcl` 的 rename；用 `-plugin-dir` 并关沙箱 |
| Lambda 报 `image manifest ... not supported` | buildx 把镜像做成了 OCI index；必须 `provenance: false` |
| `reserved concurrency` 400 | 账号总并发 50，任何预留都会被拒；串行化靠条件写，不靠预留 |
| 安卓显示「网络不可用」 | 先用手机浏览器打开同地址；离线页会印 WebView 错误码与 URL |

---

## 附录 B · 术语 / Glossary

| 词 / Term | 一句话 / In one line |
| --- | --- |
| 预签名 URL | 把一次 PUT 的权限签进 URL，客户端直连 S3 |
| 分段上传 | 大文件切 8MB 逐片上传，最后服务端合并 |
| OAC | CloudFront 用 SigV4 签名回源私有桶（替代已弃用的 OAI） |
| 条件写 | `If-Match` / `If-None-Match`，用 ETag 做乐观锁 |
| 指针文件 | `data/version.json`，`no-store`，指向当前清单 |
| 前缀分域 | 每个写者只碰自己的前缀，杜绝互相删除 |
| 失效（invalidation） | 让 CDN 丢弃某个路径的缓存副本 |
| DLQ | 死信队列，处理失败的消息落在这里 |
