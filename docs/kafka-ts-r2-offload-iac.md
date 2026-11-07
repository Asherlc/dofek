# Kafka tiered storage — R2 IaC (stock Cloudflare provider)

Dedicated R2 bucket + long-lived Object RW account token for Apache Kafka 4.4 +
Aiven RSM 1.2.0. Metric-stream JSONL archive and account-erasure ledger in
[`deploy/storage.tf`](../deploy/storage.tf) stay untouched.

**No TF apply / bucket create / key mint / deploy / Infisical grant from this
doc alone.** Resources are always declared (no enable-flag). Next
`deploy-terraform` apply will attempt create — hold that until Root ACK of
gates A–B below.

## Terraform owns

| Resource | Notes |
|---|---|
| `cloudflare_r2_bucket.kafka_ts_offload` | Name `dofek-kafka-ts-offload`; `prevent_destroy`; no Object Lock |
| `cloudflare_r2_bucket_lifecycle.kafka_ts_offload_abort_mpu` | Abort incomplete MPU after 1d only — **no** live object age expiry (Kafka/RSM GC) |
| `cloudflare_account_token.kafka_ts_offload_object_rw` | Bucket-scoped **Workers R2 Storage Bucket Item Write** |
| `infisical_secret` ×5 | `KAFKA_TIERED_STORAGE_{BUCKET,ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}` at `prod` `/` |

Providers: existing `cloudflare` `~> 5.0` + `infisical` `0.20.12`. **Backblaze/b2 removed**
(Pulsar B2 offload IaC retired; never applied).

Sources:
[account_token](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/resources/account_token),
[account_api_token_permission_groups_list](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/data-sources/account_api_token_permission_groups_list),
[Create Token API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/),
[List Tokens API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/list/),
[Create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/),
[Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[R2 tokens / S3 mapping](https://developers.cloudflare.com/r2/api/tokens/),
[r2_bucket_lifecycle](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/resources/r2_bucket_lifecycle).

## Runtime env contract (3d maps into broker)

| Infisical key | Broker use |
|---|---|
| `KAFKA_TIERED_STORAGE_BUCKET` | RSM `s3.bucket.name` |
| `KAFKA_TIERED_STORAGE_ENDPOINT` | RSM `s3.endpoint.url` (`https://<account>.r2.cloudflarestorage.com`) |
| `KAFKA_TIERED_STORAGE_REGION` | RSM `s3.region` = `auto` |
| `KAFKA_TIERED_STORAGE_ACCESS_KEY_ID` | → process `AWS_ACCESS_KEY_ID` (default chain) |
| `KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY` | → process `AWS_SECRET_ACCESS_KEY` (SHA-256 of account token value) |

Also required on broker when TS enabled (stock Phase F proof):
`AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`,
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`.

Never set `KAFKA_RSM_CONFIG_STORAGE_AWS_ACCESS_KEY_ID` / `_SECRET` / `_SESSION_TOKEN`
static RSM fields. Never reuse archive `R2_ACCESS_KEY_*` or erasure ledger keys.
Stack/runtime wiring is **3d-owned** — not this file.

## A. Cloudflare — Account API Tokens Write (docs proof)

### Required permission (create child Object RW token)

| Operation | Endpoint | Accepted permission (at least one) |
|---|---|---|
| Create account-owned token | `POST /accounts/{account_id}/tokens` | **`Account API Tokens Write`** |
| List account-owned tokens | `GET /accounts/{account_id}/tokens` | `Account API Tokens Write` **or** `Account API Tokens Read` |
| List account permission groups | `GET /accounts/{account_id}/tokens/permission_groups` | `Account API Tokens Write` **or** `Account API Tokens Read` |

Citations:
- [Create Token](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/) — accepted permissions: **`Account API Tokens Write`** only.
- [List Tokens](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/list/) — Write or Read.
- [Create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/) — initial managing token must be created in the dashboard with **Account > Account API Tokens > Edit** before the API can mint subsequent account-owned tokens.
- [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) — members need API Token Provisioning or Super Administrator; creator may only grant a subset of their own account permissions.
- Terraform [`cloudflare_account_token`](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/resources/account_token) — accepted permissions Read/Write (Write required to create).

User-owned token APIs (`/user/tokens`, `cloudflare_api_token`) are a **different** permission class (`API Tokens Write` / Create additional tokens template) and are **not** the path used here.

### Observed gap (Root readonly — no writes)

| Probe | Credential | Result |
|---|---|---|
| `GET /user/tokens/permission_groups` | Infisical `CF_API_TOKEN` | **403 / 9109 Unauthorized** (prior) |
| `GET /accounts/{id}/tokens` | Infisical `CF_API_TOKEN` | **403 / 9109 Unauthorized** (current) |
| `GET …/r2/buckets/…` | Infisical `CF_API_TOKEN` | 404 missing bucket (auth OK for R2 read; not Account Tokens) |

**Do not assume** GitHub/HCP `CLOUDFLARE_API_TOKEN` can create `cloudflare_account_token` until a list/create-capable probe succeeds. Current Infisical `CF_API_TOKEN` proves **no** Account API Tokens Read/Write.

### Configured CF operator auth sources (names only — Root inventory)

| Name | Where configured | Role today |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret → `TF_VAR_cloudflare_api_token` + stack `CF_DNS_API_TOKEN` | TF Cloudflare provider + Traefik/DNS |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret → `TF_VAR_cloudflare_account_id` | Account id only |
| `CF_API_TOKEN` | Infisical `prod` `/` | Operator/REST preflight (no Account Tokens) |
| `R2_ACCESS_KEY_ID` | Infisical `prod` `/` | Archive/media S3 access key id (manual dashboard) |
| `R2_SECRET_ACCESS_KEY` | Infisical `prod` `/` | Archive/media S3 secret |
| `R2_ENDPOINT` | Infisical `prod` `/` | Archive/media S3 endpoint |

Do **not** reuse `R2_*` as Kafka TS broker creds or as Account Token mint parents. Lab temp-access-credentials remain lab-only — **forbidden** for prod bootstrap / renewal / runtime parent fallback.

### Minimal higher-privileged bootstrap (stock only)

1. Operator with Super Administrator **or** API Token Provisioning opens Cloudflare dashboard → **Manage account → Account API Tokens → Create Token**
   ([Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
   [Create tokens via API — generating the initial token](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)).
2. Grant the managing token at least:
   - **Account → Account API Tokens → Edit** (`Account API Tokens Write`) — mint/list child tokens + permission groups data source.
   - Existing TF needs: **Zone Edit**, **DNS Edit**, **Workers R2 Storage Edit** (bucket create/lifecycle) — either keep on the same managing token or retain current GH secret scopes and **add** Account API Tokens Edit only.
3. Replace GitHub secret `CLOUDFLARE_API_TOKEN` with that managing token value (same name; feeds TF + `CF_DNS_API_TOKEN`). No new secret name / dual-token framework unless Root later splits DNS vs TF (YAGNI — prefer one upgraded managing token).
4. Root readonly verify (names only in logs): `GET /accounts/{id}/tokens` returns **200** (not 403/9109). Then permission-groups list for `Workers R2 Storage Bucket Item Write` succeeds.
5. Child Object RW token is **only** created by Terraform `cloudflare_account_token.kafka_ts_offload_object_rw` (bucket-scoped). Broker receives child S3 mapping via Infisical `KAFKA_TIERED_STORAGE_*` — **never** the managing Bearer, **never** temp-access parent, **never** custom renewal service.

Forbidden: DIY JWT signer, temp-cred renewal service, runtime parent fallback, broadening user-token APIs, inventing a second cloud credential framework.

## B. Infisical CI write for `KAFKA_TIERED_STORAGE_*`

| Item | Status |
|---|---|
| CI identity | `46b66f72-0c77-4cfe-be1b-a43395e77be7` (stock `viewer`) |
| Project id | `54712f56-98a9-4531-9e97-0b588d2e5a88` |
| Custom project roles | **Blocked** (`plan.rbac` / Enterprise) — do not retry |
| Pulsar privilege slug `gha-pulsar-offload-b2-secrets` | **Obsolete** — never POST |
| Needed | Stock **identity additional privilege** slug `gha-kafka-ts-r2-secrets` |
| API | [`POST /api/v2/identity-project-additional-privilege`](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create) |
| Grant | **Root only after user approval** — Cursor does not grant |

Preserve `viewer` membership; do not PATCH roles for this grant.

### Exact create body (do not POST until user approves)

```json
{
  "identityId": "46b66f72-0c77-4cfe-be1b-a43395e77be7",
  "projectId": "54712f56-98a9-4531-9e97-0b588d2e5a88",
  "slug": "gha-kafka-ts-r2-secrets",
  "type": { "isTemporary": false },
  "permissions": [
    {
      "subject": "secrets",
      "action": ["describeSecret", "readValue", "create", "edit"],
      "conditions": {
        "environment": "prod",
        "secretPath": "/",
        "secretName": { "$glob": "KAFKA_TIERED_STORAGE_*" }
      }
    }
  ]
}
```

Stock curl (held — approval gate):

```bash
curl -fsS -X POST -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  -H "Content-Type: application/json" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege" \
  -d @- <<'EOF'
{
  "identityId": "46b66f72-0c77-4cfe-be1b-a43395e77be7",
  "projectId": "54712f56-98a9-4531-9e97-0b588d2e5a88",
  "slug": "gha-kafka-ts-r2-secrets",
  "type": { "isTemporary": false },
  "permissions": [
    {
      "subject": "secrets",
      "action": ["describeSecret", "readValue", "create", "edit"],
      "conditions": {
        "environment": "prod",
        "secretPath": "/",
        "secretName": { "$glob": "KAFKA_TIERED_STORAGE_*" }
      }
    }
  ]
}
EOF
```

Post-create readback: GET privilege by id; assert slug, `isTemporary=false`, glob `KAFKA_TIERED_STORAGE_*`, actions only those four; membership still `viewer` (no member/admin/custom role attach).

## Enable sequence (after both gates)

1. Root inventories CF auth source names above; upgrades managing `CLOUDFLARE_API_TOKEN` with Account API Tokens Edit; verifies `GET /accounts/{id}/tokens` = 200.
2. User approves Infisical packet `gha-kafka-ts-r2-secrets`; Root POSTs privilege; verify list/readback.
3. Normal `deploy-terraform` / `terraform apply` creates always-declared Kafka TS resources (no flag).
4. 3d wires stack dotenv → broker AWS default chain + RSM nonsecret bucket/endpoint/region.
5. No recreate of lab disposable bucket names; no touch of lifecycle tiny-1 B2 fixture (Nov11 cleanup still owned).

## Retired (this change)

- `enable_kafka_tiered_storage_r2` / `count` gates (YAGNI stopgap — removed)
- `deploy/b2-pulsar-offload.tf` (never applied; no `PULSAR_OFFLOAD_B2_*` secrets created)
- `docs/b2-pulsar-offload-iac.md`, `docs/b2-pulsar-offload-broker-stack-hunks.md`
- `Backblaze/b2` provider + workflow `B2_APPLICATION_KEY_*` requirements

Original Codex B2 management key and `/tmp/b2-lifecycle-tiny-1/` remain untouched.
