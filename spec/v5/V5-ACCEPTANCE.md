# V5 Acceptance Matrix / V5 验收矩阵

> This document is the release gate. A capability is not accepted because a
> parser, fixture, or unit test exists; it needs production evidence.
>
> 2026-11-13 校准 / recalibrated: 本矩阵与 [`tasks.md`](./tasks.md) 的口径已对齐。
> `tasks.md` 的 ✅ 只表示「代码已入库」，**不代表验收通过**；判定只看这里。
> 核查过程见 [`review.md`](./review.md)。
>
> 2026-11-14 校准 / recalibrated: 语义搜索链路已接入生产并完成实机验收，
> 下方矩阵按「已取得的生产证据」重述；未拿到证据的 release blockers 保持开放，
> V5 **仍不得宣布完全验收**。
>
> *On 2026-11-14 the semantic-search pipeline reached production and was accepted on the
> live site. The matrix below restates the evidence actually obtained; blockers without
> evidence remain open and V5 **must not be declared fully accepted**.*

## Status summary

| Success criterion | Status | Evidence / blocker |
| --- | --- | --- |
| Apple-style responsive home, hero chapters, accessible motion | **Partial** | Hero registry (`site.json` → `manifest.heroSections`, capped at 8), `srcset` preloading of the current and next slide, reduced-motion and low-performance fallback are implemented. Browser acceptance on the real photo set is still required. |
| Natural-language semantic image search | **生产已接线并实机验收 / Wired and accepted on production**; still **Partial** against the six examples | 版本化静态索引 `data/search-index.<rev>.json` 与兜底 `data/search-index.json` 已发布（2026-11-14 核验：`rev=72fbe1c4c299…`，47 条、34 张带识别标签）；识别输入恒为脱敏派生图 `photos/<id>/grid.webp`，经 WebP→JPEG 送 Rekognition，标签按图存 `data/labels/<id>.json`；新上传在 processor 内 best-effort 识别并重建索引。**实机验收**：黑色、白色、绿色、山峰、湖水、汽车均返回结果；2026-11-14 另用真实上传链路两次验证颜色命中新图（见下两节）。**仍未达成**：六个示例未全部命中（「摩托车」无结果，见 V6 B-02；「山峰」在当前语料中无标签，见 V6 B-06）；词表外词静默返回全量（V6 B-05）。correlation ID 已于 2026-11-14 第二次取证闭环，不再是本行缺口。 / *A versioned static index is published from redacted derivatives, backfilled for 34 of 47 items, accepted on the live site for colour and scene queries, and re-verified end-to-end twice with real uploads on 2026-11-14; six-example coverage and out-of-vocabulary behaviour remain unmet. Correlation-ID propagation was closed by the second run.* |
| Unified CI/CD, resources, logs, metrics, security and billing management | **Partial** | `cx.chenyouyi.top` is deployed and read-only. CI/CD/resources/security are fixture-backed; Logs, Metrics and Billing explicitly report unavailable until their adapters are connected. |
| Structured evidence for upload, processing, publishing and infrastructure changes | **Partial** | 基础设施证据齐备：CloudWatch 日志、Terraform state、GitHub 工作流产物；生产 S3 对象证据（`data/labels/<id>.json` ×34、版本化索引、兜底索引）、CI run `43560052551`，以及 2026-11-14 两次真实上传的 S3 事件 → 三档产物 → 标签 → 清单 → 索引 → 搜索命中全链路日志（见下两节）。correlation ID 已在第二次取证中闭环：两个 CloudWatch 日志组按同一 ID 可查到 `upload / processor / publish / recognition / index / invalidation` 全阶段，CloudTrail 的 `CreateInvalidation` 请求参数也带同一 ID。**仍缺**管理站 Logs/Metrics/Billing 的真实运维数据、识别失败的生产故障注入证据、以及三端浏览器 + reduced-motion 记录。 / *Infrastructure evidence and two complete real-upload traces exist. The second run closed the correlation-ID requirement with a single-ID trace across both log groups and a matching CloudTrail CallerReference. Still missing: real management-site operations data, production failure-injection evidence and three-platform browser records.* |
| Layered, least-privilege, planable and rollbackable infrastructure | **Pass** | `30-compute` and `40-management-edge` are independent Terraform states; immutable image digest, IAM roles, HTTPS-only origin, SG boundary and plan/apply evidence are recorded. |

## Required acceptance commands

```bash
# Management surface
curl -fsS https://cx.chenyouyi.top/
curl -fsS https://cx.chenyouyi.top/actuator/health
curl -fsS -H 'X-Correlation-Id: v5-acceptance-001' \
  https://cx.chenyouyi.top/api/management/snapshot

# Photo surface
curl -fsS https://photos.chenyouyi.top/

# Local contract and search tests
cd 个人相册
npm test
npm run build
```

## Delivery hygiene / 交付卫生

2026-11-13 起，四个仓库的 V5 源码全部入库：`spec/v5`（含 `spec`/`plan`/`contracts`）、
`src/server/{search,recognition}`、`40-management-edge` 全层与 `observability/`。
**此前 `40-management-edge` 已 apply 到生产但四个文件未跟踪**，属最高风险项，现已修正。
本地提交**尚未推送**，需人工审阅后推送。

*Since 2026-11-13 all V5 source lives in git. The management edge layer had been applied to
production while four of its files were untracked — the highest-risk defect, now fixed. Commits
are local and await review before pushing.*

## 2026-11-14 端到端上传实测 / End-to-end upload run

**中文 / Chinese**
一次真实 S3 上传链路实测（blocker #4 取证），使用无 EXIF 的合成 JPEG（19,628 B，
蓝底 + 白块 + 黑块），对象 `incoming/album-e2e-1794639534.jpg`，内容哈希派生
`id=014c3f80998f`。链路证据：

- S3 事件自动触发 processor；CloudWatch `/aws/lambda/album-processor` RequestId
  `ebf30147-57ca-4eeb-9c76-33499661e241`，日志依次为 `process.recognition`
  （`outcome=recognized`、`rev=de5476fcba37`、`recognized=35`、1865ms）与
  `process.done`（清单 `rev=dd59032b462c`），整次调用 3.4s，源对象自动删除。
- 产物 `photos/014c3f80998f/{thumb,grid,view}.webp`；`data/labels/014c3f80998f.json`
  含 10 个标签（`blue`/`white`/`black` 及 `screen`/`monitor`/`white board` 等）；
  清单 48 条，新条目只有 id / 年月 / 标签 / 派生图路径，无 GPS、原始文件名、具体时刻。
- 索引 `rev=de5476fcba37…`、48 条、35 张带识别标签；用前端同一 `runSearch()` 离线验证：
  「蓝色」23 条、「白色」4 条、「黑色」26 条、「蓝色 白色」3 条，均命中测试图，
  `fromIndex=true, degraded=false`；「摩托车」0 条。
- **当时未达成、现已闭环的部分**：结构化日志只有资产 `id`，没有契约要求的 `corr_…`
  correlation ID 贯穿 —— `recognition.mjs` 生成的 ID 仅作为识别输入字段存在。
  该缺口已由新镜像 `bd9d1229aef8` 的第二次生产取证关闭，**见下一节**；本节保留为第一次实测记录。
- **清理已完成**：删除 6 个测试对象（3 张派生图、1 个标签、1 个版本清单、1 个版本索引），
  恢复 `data/version.json` 与 `data/search-index.json`（ETag 与基线完全一致），
  `data/` 69 个与 `photos/` 128 个对象逐键比对无差异；CloudFront invalidation
  `I24JW7FI0WWARCP8WBYHGQMNX4` 已 `Completed`，公网索引 `rev` 回到
  `72fbe1c4c299…`，测试图 id 不再出现。

*English*
A real S3 upload was exercised with an EXIF-free synthetic JPEG. The event triggered
the processor, which produced three derivatives, a 10-label recognition document, a
48-item manifest and a 48-item search index; the frontend `runSearch()` returned the
new photo for blue / white / black queries from the index. At the time the contract-defined
`corr_…` correlation ID was **not** propagated through structured logs (only the asset
id is); that gap was later closed by the second production run in the next section. All
six test objects were deleted, the version
pointer and index restored byte-identically (matching ETags), object-key sets matched
the 69/128 baseline, and the CDN invalidation completed with the public index back on
its original rev.

## 2026-11-14 blocker #4 生产取证完成，判定关闭 / Production evidence obtained, blocker closed

**中文 / Chinese**

代码（album PR #9，镜像 `bd9d1229aef8`）、部署（album-infra PR #11；main 上 apply run
`43580970538`，`0 added / 2 changed / 0 destroyed`，两个 Lambda 均换到新镜像）与生产取证
三段全部完成。第二次真实上传走 HTTP `/health` → `/auth` → `/upload-url` → S3 PUT →
S3 事件触发 processor，`correlationId = corr_bb6f8616101611d0`，资产 `id=855295971e6c`。

| 中文 / Chinese | English |
| --- | --- |
| **入口**：`/upload-url` 响应头 `x-correlation-id: corr_bb6f8616101611d0`；预签名 PUT 头含 `x-amz-meta-correlation-id`（同为签名头），S3 PUT 返回 200。 | **Entry**: the `/upload-url` response carries `x-correlation-id: corr_bb6f8616101611d0`; the presigned PUT includes `x-amz-meta-correlation-id` as a signed header and returned 200. |
| **auth 日志组** `/aws/lambda/album-auth`：`upload.presigned`（stage `upload`、outcome `success`、17ms）。 | **auth log group**: one `upload.presigned` event, stage `upload`, outcome `success`, 17 ms. |
| **processor 日志组** `/aws/lambda/album-processor`：同一 ID 依次出现 `process.started` → `manifest.published`（160ms）→ `recognition.completed`（447ms，`provider=aws-rekognition`）→ `index.published`（1287ms）→ `invalidation.created`（781ms）→ `process.done`（3037ms）；两条旧式 `process.*` 日志也带该 ID。 | **processor log group**: the same ID appears on `process.started`, `manifest.published` (160 ms), `recognition.completed` (447 ms, `aws-rekognition`), `index.published` (1287 ms), `invalidation.created` (781 ms) and `process.done` (3037 ms); two legacy `process.*` lines carry it too. |
| **CDN 闭环**：CloudTrail（us-east-1）`CreateInvalidation` 09:34:49Z，`callerReference = album-corr_bb6f8616101611d0-1794648888550-ni935m`，失效 `I9ZUQWCAKWZKOEQGTNRXDAB27I`，发起者 `album-processor-role`。`GetInvalidation` 不回传 CallerReference，唯一读回途径是 CloudTrail 事件记录。 | **CDN loop**: the us-east-1 CloudTrail `CreateInvalidation` event at 09:34:49Z carries `callerReference = album-corr_bb6f8616101611d0-1794648888550-ni935m` for `I9ZUQWCAKWZKOEQGTNRXDAB27I`, issued by `album-processor-role`. `GetInvalidation` does not return CallerReference; CloudTrail is the only read-back path. |
| **产物与命中**：三档派生图、`data/labels/855295971e6c.json`（732 B）、版本化清单与索引生成；索引 48 条，新条目含 `labels / colors / source=rekognition`。用前端同一 `runSearch()` 对真实索引离线验证：「黑色」26 条、「白色」4 条，`fromIndex=true, degraded=false`，均命中新图。 | **Artifacts and hits**: three derivatives, a 732 B label document, a versioned manifest and index. The 48-item index holds the new photo with `rekognition` labels/colors; offline `runSearch()` returns 26 hits for black and 4 for white, `fromIndex=true, degraded=false`, both including the new photo. |
| **口径边界**：「显示器」返回全量 48 条（V6 B-05）、「山峰」0 条（V6 B-06）；基线索引与上传后索引对这两词结果**完全一致**，证明本次改动无回归，两项留 V6。 | **Scope**: out-of-vocabulary "monitor" returns all 48 (V6 B-05), "mountain peak" returns 0 (V6 B-06). Baseline and post-upload indexes behave identically, so there is no regression; both stay in V6. |
| **清理**：删除 6 个测试对象（3 派生图 + 1 标签 + 1 版本清单 + 1 版本索引），恢复 `data/version.json` / `data/search-index.json` 至基线 ETag `c8468018…` / `35de7709…`；`data/` 69 与 `photos/` 128 逐键逐 ETag 零差异；失效 `I58ANHZ9HSB9CZF7WS1B7MP3DO`；公网 `rev=a75ad99f29dd`、索引 `rev=72fbe1c4c299…` 47 条，测试 id 消失。 | **Cleanup**: six test objects deleted, version pointer and index restored to baseline ETags, all 69 `data/` and 128 `photos/` keys/ETags matched exactly, invalidation `I58ANHZ9HSB9CZF7WS1B7MP3DO` refreshed the CDN, and the public site is back on `rev=a75ad99f29dd` / `72fbe1c4c299…` with 47 items and no test id. |

**设计（保留）/ Design (unchanged)**：ID = `corr_` + 内容寻址对象 key 的 sha256 前 16 位，
因此重试、S3 事件回放、`/upload-complete` 只有 key、旧对象缺元数据四种情况都算出同一个 ID，
不需要前端改动，也不触发新的 CORS 预检头。传播点：`/upload-url` 写入
`x-amz-meta-correlation-id`（单次 PUT 客户端带签名头，分片由 `CreateMultipartUpload` 固定）
→ `store.head()` 恢复 → `process.*` → `commitManifest` 的 `publish` → `buildRecognitionInput`
→ `index.published` → CloudFront `CallerReference`；`/upload-complete` 由 key 重算。
日志走 `buildLogEvent`，必填 `event / correlationId / stage / outcome / durationMs`，
stage 覆盖 `upload / processor / publish / recognition / index / invalidation`；
`trace()` 对字段错误只留 warn，日志绝不让上传失败。

**离线证据 / Offline evidence**：`npm test` 186/186；`npm run verify` 40 项（含第 40 项
跨文件链路防回归断言）；`npm run check:repo` 126 文件；`npm run build` 通过；假凭证真实预签名
冒烟（`X-Amz-SignedHeaders` 含 `x-amz-meta-correlation-id`、元数据未被提到查询串）；
`/var/task` 布局下 auth 与 processor 整条依赖链导入通过；临时 Lambda 真实 invoke 两个入口通过。

**判定 / Verdict**：blocker #4「一次真实上传在上传、处理、清单发布与搜索索引间有同一
correlation ID 的追踪链」已具备生产证据，**关闭**。V5 整体仍不得宣布完全验收（见下节）。

*English: The code, the deployment to both Lambdas and the production run are complete. A
single `corr_bb6f8616101611d0` ID is readable in the presign response header, in both
CloudWatch log groups across upload / processor / publish / recognition / index /
invalidation, and in the CloudFront CallerReference recorded by CloudTrail. The real
index returns the newly uploaded photo for colour queries. All six test objects were
removed and the 69/128 object baseline plus the public rev were restored byte-identically.
The two out-of-vocabulary / corpus gaps behave identically before and after the upload,
so they are V6 items, not regressions. Blocker #4 is closed; V5 as a whole is still not
fully accepted.*

## Release blockers

2026-11-14 进度 / *Progress as of 2026-11-14*：#1 前半段（脱敏派生图产出识别标签 +
可解释查询）已有生产索引、实机验收与两次真实上传证据，但「六个示例全部命中」未达成；
**#4 已关闭**：代码、镜像、生产取证与清理闭环，同一 ID 贯穿两个日志组与 CDN（见上一节）。
#2 有代码级 best-effort 降级与单测，但缺生产故障注入证据；#3 #6 属管理站，
用户已决定保持关站（`mgmt_enabled=false`）、代码就绪后由用户发话再一键拉起；
#5 的 V5 前端三端/reduced-motion 记录未见。
*Blocker #1 is partially met (production labels, explainable queries and two real-upload
runs), but full six-example coverage is unmet; **#4 is closed** — code, image, production
evidence and cleanup all line up behind one ID. #2 has code and unit tests but no
production failure-injection evidence; #3 and #6 depend on the management site, which
stays switched off until the user explicitly asks for the one-click bring-up; #5 has no
recorded V5 browser checks.*

V5 must not be declared fully accepted until all of these have evidence:

1. A real manifest contains recognition labels produced from a redacted derivative,
   and queries for the six semantic examples return explainable results.
2. Recognition failure leaves publication successful and baseline year/tag filters usable.
3. The management adapters for Logs, Metrics and Billing return **real, permission-scoped
   operational data**. 用户已明确否决「经批准的运维降级 / approved operational fallback」
   （即显示「暂无数据」并签字认可），此路不再作为可选项；管理站必须读真实数据。
   *The user explicitly rejected any "approved operational fallback"; real read-only data
   is mandatory.*
4. One real upload has a correlation ID trace across upload, processing, manifest
   publication and search indexing. **✅ 已满足 / satisfied 2026-11-14**：`corr_bb6f8616101611d0`，
   见「blocker #4 生产取证完成」一节。 / *Closed with a single-ID trace across both log
   groups and the CloudFront CallerReference.*
5. Desktop, mobile and reduced-motion browser checks are recorded against the
   current production photo set.
6. `/api/management/snapshot` stops reporting `status: planned` for resources that are
   `ACTIVE`/`Deployed`: either connect a real read-only inventory adapter or report `unknown`
   explicitly. A read-only surface must not publish the opposite of reality.

## Explicit non-claims

- Fixture rows are not production resource, workflow, log, metric or billing data.
- A Chinese query parser is not an image-understanding model.
- A successful ECS health check does not prove the V5 frontend or semantic search
  acceptance criteria.
- DNS, App Runner removal and write API enablement remain separate approvals.
