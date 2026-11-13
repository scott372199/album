# V5 Acceptance Matrix / V5 验收矩阵

> This document is the release gate. A capability is not accepted because a
> parser, fixture, or unit test exists; it needs production evidence.
>
> 2026-11-13 校准 / recalibrated: 本矩阵与 [`tasks.md`](./tasks.md) 的口径已对齐。
> `tasks.md` 的 ✅ 只表示「代码已入库」，**不代表验收通过**；判定只看这里。
> 核查过程见 [`review.md`](./review.md)。

## Status summary

| Success criterion | Status | Evidence / blocker |
| --- | --- | --- |
| Apple-style responsive home, hero chapters, accessible motion | **Partial** | Hero registry (`site.json` → `manifest.heroSections`, capped at 8), `srcset` preloading of the current and next slide, reduced-motion and low-performance fallback are implemented. Browser acceptance on the real photo set is still required. |
| Natural-language semantic image search | **Partial / 未接线** | The UI exposes `湖水`, `山峰`, `蓝天`, `汽车`, `摩托车` and `红色衬衫` suggestions; `search/query.mjs` and `search/index.mjs` exist with tests, and the local tag/year fallback works. **No runtime is connected**: no HTTP route, no queue, no index persistence, so the six examples are not served by a recognition pipeline. |
| Unified CI/CD, resources, logs, metrics, security and billing management | **Partial** | `cx.chenyouyi.top` is deployed and read-only. CI/CD/resources/security are fixture-backed; Logs, Metrics and Billing explicitly report unavailable until their adapters are connected. |
| Structured evidence for upload, processing, publishing and infrastructure changes | **Partial** | Correlation IDs, CloudWatch logs, Terraform state and GitHub workflow artifacts provide infrastructure evidence. End-to-end upload → processing → publish → search evidence still needs a real-photo run. |
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

## Release blockers

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
