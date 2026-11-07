# Kafka tiered storage — R2 IaC (stock Cloudflare provider)

Dedicated R2 bucket + long-lived Object RW account token for Apache Kafka 4.4 +
Aiven RSM 1.2.0. Metric-stream JSONL archive and account-erasure ledger in
[`deploy/storage.tf`](../deploy/storage.tf) stay untouched.

**No TF apply / bucket create / key mint / deploy from this doc alone.** Module
defaults to `enable_kafka_tiered_storage_r2=false`.

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
[account_token](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/account_token),
[account_api_token_permission_groups_list](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/account_api_token_permission_groups_list),
[R2 tokens / S3 mapping](https://developers.cloudflare.com/r2/api/tokens/),
[r2_bucket_lifecycle](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket_lifecycle).

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

## Authorization unresolved (Root — do not grant from Cursor)

### A. Cloudflare account-owned token create

| Item | Status |
|---|---|
| User token API (`/user/tokens`, `cloudflare_api_token`) | **Cannot** assume — lab CF token got **403/9109** on permission_groups |
| Stock path | `cloudflare_account_token` + account permission-groups data source |
| Managing credential need | **Account API Tokens Read/Write** ([accepted permissions](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/account_token)) |
| Current `CLOUDFLARE_API_TOKEN` | Unknown for Account API Tokens Write — **Root validates read-only** (e.g. list account permission groups / dry capability) before flipping the enable flag |
| Custom bootstrap / temp-cred renewer | **Forbidden** |

If Account API Tokens Write is missing: Root upgrades managing token (or provisions a dedicated TF-admin account token) via stock CF dashboard/API — **no** DIY framework.

### B. Infisical CI write for `KAFKA_TIERED_STORAGE_*`

| Item | Status |
|---|---|
| CI identity | `46b66f72-0c77-4cfe-be1b-a43395e77be7` (stock `viewer`) |
| Custom project roles | **Blocked** (`plan.rbac` / Enterprise) — do not retry |
| Pulsar privilege slug `gha-pulsar-offload-b2-secrets` | **Obsolete** — never POST |
| Needed | Stock **identity additional privilege** scoped to `secretPath=/`, `secretName.$glob=KAFKA_TIERED_STORAGE_*`, env `prod` — **new** slug e.g. `gha-kafka-ts-r2-secrets` |
| API | [`POST /api/v2/identity-project-additional-privilege`](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create) |
| Grant | **Root only after user approval** of this Kafka-specific packet — Cursor does not grant |

Preserve `viewer` membership; do not PATCH roles for this grant.

## Enable sequence (after both gates)

1. Root confirms managing CF token can create account tokens (or installs Account API Tokens Write).
2. User approves Infisical Kafka TS privilege packet; Root POSTs privilege; verify list/readback.
3. Set `enable_kafka_tiered_storage_r2=true` (HCP var / `TF_VAR_…`) and `terraform apply` via normal deploy-terraform path.
4. 3d wires stack dotenv → broker AWS default chain + RSM nonsecret bucket/endpoint/region.
5. No recreate of lab disposable bucket names; no touch of lifecycle tiny-1 B2 fixture (Nov11 cleanup still owned).

## Retired (this change)

- `deploy/b2-pulsar-offload.tf` (never applied; no `PULSAR_OFFLOAD_B2_*` secrets created)
- `docs/b2-pulsar-offload-iac.md`, `docs/b2-pulsar-offload-broker-stack-hunks.md`
- `Backblaze/b2` provider + workflow `B2_APPLICATION_KEY_*` requirements

Original Codex B2 management key and `/tmp/b2-lifecycle-tiny-1/` remain untouched.
