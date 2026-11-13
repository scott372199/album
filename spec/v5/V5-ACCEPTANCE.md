# V5 Acceptance Matrix / V5 验收矩阵

> This document is the release gate. A capability is not accepted because a
> parser, fixture, or unit test exists; it needs production evidence.

## Status summary

| Success criterion | Status | Evidence / blocker |
| --- | --- | --- |
| Apple-style responsive home, hero chapters, accessible motion | **Partial** | The photo site has the navigation, hero, story and photo-wall implementation. Browser acceptance on the real photo set is still required. |
| Natural-language semantic image search | **Partial** | Query parsing and local tag fallback exist for `湖水`, `山峰`, `蓝天`, `汽车`, `摩托车`, and year filters. A production recognition/index pipeline is not connected to the public manifest, so this is not yet semantic-search acceptance. |
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

## Explicit non-claims

- Fixture rows are not production resource, workflow, log, metric or billing data.
- A Chinese query parser is not an image-understanding model.
- A successful ECS health check does not prove the V5 frontend or semantic search
  acceptance criteria.
- DNS, App Runner removal and write API enablement remain separate approvals.
