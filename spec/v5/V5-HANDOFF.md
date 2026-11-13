# V5 Handoff / V6 Portability

## Current release boundary

V5 is deployed as two independently managed surfaces:

- **Photo site**: the existing S3 website and its existing CloudFront path.
- **Management site**: Spring Boot read-only API on ECS Express Mode, fronted by an independent CloudFront distribution.

The management URL is `https://cx.chenyouyi.top/`. Verified endpoints:

- `GET /actuator/health` returns `200` and `{"status":"UP"}`.
- `GET /api/management/snapshot` returns the read-only management model.
- HTTP requests redirect to HTTPS.
- `X-Correlation-Id` is returned by the management service and edge path.

The management API remains **read-only**. Do not add write operations, administrator
passwords, or DNS automation without updating the V5 spec and re-running the security review.

## Infrastructure inventory

| Layer | Responsibility | State key |
| --- | --- | --- |
| `30-compute` | ECR, ECS Express service, IAM roles, logs, scaling | `30-compute/terraform.tfstate` |
| `40-management-edge` | ACM reference and management CloudFront distribution | `40-management-edge/terraform.tfstate` |

Important runtime identifiers are outputs, not application constants:

- ECS service: `album-mgmt`
- ECS origin: emitted by `30-compute`
- CloudFront distribution: `EX15BSO66B05G`
- CloudFront domain: `d3ordflcyau05c.cloudfront.net`
- ACM certificate: in `us-east-1`, DNS validated

The image is pinned by immutable ECR digest. Never replace it with `latest`.

## Repeatable verification

```bash
cd album-infra/layers/30-compute
terraform plan -input=false -var-file=prod.tfvars

cd ../40-management-edge
terraform plan -input=false -var-file=prod.tfvars

curl -fsS https://cx.chenyouyi.top/actuator/health
curl -fsS -H 'X-Correlation-Id: v5-verification' \
  https://cx.chenyouyi.top/api/management/snapshot
```

Expected infrastructure checks:

- ECS deployment is `ACTIVE` and steady-state.
- CloudFront is `Deployed`, origin is HTTPS-only, and minimum viewer TLS is `TLSv1.2_2021`.
- Allowed methods are `GET`, `HEAD`, and `OPTIONS`.
- ECS task port `8080` accepts ingress only from the CloudFront/ALB security group.
- Management logs retain for 14 days.

## V6 portability contract

The implementation should remain portable to Kiro, WorkBuddy, or another coding agent
by treating these files as the source of truth:

1. `spec/v5/spec.md` — product and privacy invariants.
2. `spec/v5/plan.md` — architecture and operational design.
3. `spec/v5/tasks.md` — dependency order and acceptance evidence.
4. This handoff — deployed identifiers, verification commands, and release boundaries.

An agent must not infer cloud state from chat history. It should first run:

```bash
git log --oneline -10
git status --short
terraform plan -refresh-only -input=false -var-file=prod.tfvars
```

Then read the relevant layer README and task status before proposing changes.

## Remaining V6 candidates

- Add authenticated write workflows only after a reviewed threat model; reuse the
  existing phone allowlist, scrypt shared-key verification, and access/refresh-token design.
- Add branch protection, required checks, and review automation through GitHub policy,
  never by granting cloud credentials to fork pull requests.
- Replace fixture management data with a versioned read model while preserving the
  public read-only boundary.
- Add cost budgets and alerts before increasing ECS task count, CloudFront traffic,
  observability retention, or image-processing scope.
- Keep DNS cutover, App Runner removal, and write API enablement as explicit approvals.

## Explicit non-goals

Do not delete or modify the legacy App Runner path as part of V5.
Do not expose SSM values, image metadata containing secrets, original photos, EXIF,
GPS, or source filenames through the management API.
Do not put credentials, Terraform state, or production photo data in a portable handoff.
