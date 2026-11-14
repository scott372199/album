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
| Natural-language semantic image search | **生产已接线并实机验收 / Wired and accepted on production**; still **Partial** against the six examples | 版本化静态索引 `data/search-index.<rev>.json` 与兜底 `data/search-index.json` 已发布（2026-11-14 核验：`rev=72fbe1c4c299…`，47 条、34 张带识别标签）；识别输入恒为脱敏派生图 `photos/<id>/grid.webp`，经 WebP→JPEG 送 Rekognition，标签按图存 `data/labels/<id>.json`；新上传在 processor 内 best-effort 识别并重建索引。**实机验收**：黑色、白色、绿色、山峰、湖水、汽车均返回结果；2026-11-14 另用真实上传链路验证「蓝色/白色/黑色」命中新图（见下节）。**仍未达成**：六个示例未全部命中（「摩托车」无结果，见 V6 B-02）；correlation ID 未贯穿各阶段。 / *A versioned static index is published from redacted derivatives, backfilled for 34 of 47 items, accepted on the live site for colour and scene queries, and re-verified end-to-end with a real upload on 2026-11-14; six-example coverage and correlation-ID propagation remain unmet.* |
| Unified CI/CD, resources, logs, metrics, security and billing management | **Partial** | `cx.chenyouyi.top` is deployed and read-only. CI/CD/resources/security are fixture-backed; Logs, Metrics and Billing explicitly report unavailable until their adapters are connected. |
| Structured evidence for upload, processing, publishing and infrastructure changes | **Partial** | 基础设施证据齐备：CloudWatch 日志、Terraform state、GitHub 工作流产物；生产 S3 对象证据（`data/labels/<id>.json` ×34、版本化索引、兜底索引）、CI run `43560052551`，以及 2026-11-14 一次真实上传的 S3 事件 → 三档产物 → 标签 → 清单 → 索引 → 搜索命中全链路日志（见下节）。**仍缺**契约定义的 `corr_…` correlation ID 贯穿：结构化日志里只有资产 `id`，`recognition.mjs` 生成的 ID 只作为识别输入字段，未写入日志。 / *Infrastructure evidence and a complete real-upload trace exist, but the contract-defined correlation ID is not propagated through structured logs — only the asset id is.* |
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
- **未达成的部分**：结构化日志只有资产 `id`，没有契约要求的 `corr_…` correlation ID
  贯穿 upload / processing / manifest / indexing —— `recognition.mjs` 生成的 ID 仅作为
  识别输入字段存在。因此 blocker #4 仍**开放**。
- **清理已完成**：删除 6 个测试对象（3 张派生图、1 个标签、1 个版本清单、1 个版本索引），
  恢复 `data/version.json` 与 `data/search-index.json`（ETag 与基线完全一致），
  `data/` 69 个与 `photos/` 128 个对象逐键比对无差异；CloudFront invalidation
  `I24JW7FI0WWARCP8WBYHGQMNX4` 已 `Completed`，公网索引 `rev` 回到
  `72fbe1c4c299…`，测试图 id 不再出现。

*English*
A real S3 upload was exercised with an EXIF-free synthetic JPEG. The event triggered
the processor, which produced three derivatives, a 10-label recognition document, a
48-item manifest and a 48-item search index; the frontend `runSearch()` returned the
new photo for blue / white / black queries from the index. The contract-defined
`corr_…` correlation ID is **not** propagated through structured logs (only the asset
id is), so blocker #4 remains open. All six test objects were deleted, the version
pointer and index restored byte-identically (matching ETags), object-key sets matched
the 69/128 baseline, and the CDN invalidation completed with the public index back on
its original rev.

## Release blockers

2026-11-14 进度 / *Progress as of 2026-11-14*：#1 前半段（脱敏派生图产出识别标签 +
可解释查询）已有生产索引、实机验收与真实上传三重证据，但「六个示例全部命中」未达成；
#4 的上传 → 处理 → 发布 → 索引 → 搜索链路已实测跑通，**但 correlation ID 未贯穿，
仍判为开放**。#2 有代码级 best-effort 降级与单测，但缺生产故障注入证据；#3 #6 属管理站，
用户已决定保持关站（`mgmt_enabled=false`），暂不拉起；#5 的 V5 前端三端/reduced-motion
记录未见。
*Blocker #1 is partially met (production labels, explainable queries and a real-upload
run), but full six-example coverage is unmet; #4's pipeline ran end-to-end yet its
correlation-ID requirement is still open; #2 has code and unit tests but no production
failure-injection evidence; #3 and #6 depend on the management site, which the user
has chosen to keep switched off; #5 has no recorded V5 browser checks.*

V5 must not be declared fully accepted until all of these have evidence:

1. A real manifest contains recognition labels produced from a redacted derivative,
   and queries for the six semantic examples return explainable results.
2. Recognition failure leaves publication successful and baseline year/tag filters usable.
3. The management adapters for Logs, Metrics and Billing either return real,
   permission-scoped data or show an approved operational fallback.
4. One real upload has a correlation ID trace across upload, processing, manifest
   publication and search indexing.
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
