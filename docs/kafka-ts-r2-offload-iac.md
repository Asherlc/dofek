# Kafka tiered storage — R2 IaC (stock Cloudflare provider)

Dedicated R2 bucket + long-lived Object RW account token for Apache Kafka 4.4 +
Aiven RSM 1.2.0. Metric-stream JSONL archive and account-erasure ledger in
[`deploy/storage.tf`](../deploy/storage.tf) stay untouched.

**No TF apply / bucket create / key mint from this doc alone.** Resources are
always declared. Infisical CI can write `KAFKA_TIERED_STORAGE_*` (privilege
granted). Managing IAM bootstrap for the aliased R2 provider is complete
(GitHub secret `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` exists). Apply and Kafka TS
qualification remain separate gates.

## Terraform owns

| Resource | Notes |
|---|---|
| `cloudflare_r2_bucket.kafka_ts_offload` | Name `dofek-kafka-ts-offload`; `prevent_destroy`; no Object Lock; `provider = cloudflare.r2` |
| `cloudflare_r2_bucket_lifecycle.kafka_ts_offload_abort_mpu` | Abort incomplete MPU after 1d only — **no** live object age expiry (Kafka/RSM GC); `provider = cloudflare.r2` |
| `cloudflare_account_token.kafka_ts_offload_object_rw` | Bucket-scoped **Workers R2 Storage Bucket Item Write**; `provider = cloudflare.r2` |
| `data.cloudflare_account_api_token_permission_groups_list.r2_bucket_item_write` | Live PG id resolve; `provider = cloudflare.r2` |
| `infisical_secret` ×5 | `KAFKA_TIERED_STORAGE_{BUCKET,ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}` at `prod` `/` (default Infisical provider) |

Providers: default `cloudflare` `~> 5.0` (DNS + existing `storage.tf`), aliased
`cloudflare.r2` (Kafka TS R2 + child token mint only), `infisical` `0.20.12`.
Stock [provider alias](https://developer.hashicorp.com/terraform/language/providers/configuration#alias-multiple-provider-configurations)
— same Cloudflare provider source, second configuration. An alias selects
credentials per resource; it does **not** isolate jobs, runners, or state
(same `deploy-terraform` apply / HCP workspace).

Sources:
[account_token](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/resources/account_token),
[account_api_token_permission_groups_list](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/data-sources/account_api_token_permission_groups_list),
[Create Token API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/),
[Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[R2 tokens / S3 mapping](https://developers.cloudflare.com/r2/api/tokens/).

Permission-group `name` / `scope` in Terraform are **plain** strings (provider →
cloudflare-go `url.Values.Encode()` QueryEscapes; do not pre-encode `%20`).

## Runtime env

| Infisical key | Owner | Notes |
|---|---|---|
| `KAFKA_TIERED_STORAGE_*` (×5) | This IaC | Broker AWS default chain + RSM non-secret bucket/endpoint/region |
| `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` | Lane 87 + 3d | May provision later; before broker cutover |
| Infisical `CLOUDFLARE_API_TOKEN` | Traefik ACME only (`CF_DNS_API_TOKEN` in `deploy/stack.yml`) | **Unchanged** — DNS challenge only; **not** the TF R2 alias token |
| Archive `R2_*` | Existing media/archive | **Do not reuse** for Kafka TS |

Also on broker when TS enabled:
`AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`,
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`.

Do **not** change prod Infisical `METRIC_STREAM_*` topic values until an approved
drained topic-v2 cutover.

## A. Terraform credentials (durable split)

Two GitHub Actions secrets feed two Cloudflare provider configurations in the
same `deploy-terraform` job. Infisical Traefik runtime stays separate.

| Secret | TF var / provider | Permissions | Used by |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `var.cloudflare_api_token` → default `provider "cloudflare"` | Existing Zone/DNS (+ whatever already manages `storage.tf`) | `dns.tf`, `storage.tf`, other default-provider CF resources |
| `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` | `var.cloudflare_terraform_r2_api_token` → `provider "cloudflare" { alias = "r2" }` | **Account API Tokens Write** + **Workers R2 Storage Write** on account `8e5b2f62…` **only** — **no DNS / Zone** | Kafka TS resources in `kafka-ts-r2-offload.tf` that set `provider = cloudflare.r2` |

Do **not** widen the Traefik Infisical token with Account API Tokens Edit. Do **not**
put the R2 managing token in Infisical or the broker. Child Kafka Object RW is
minted by Terraform (`cloudflare_account_token`) and written to Infisical as
`KAFKA_TIERED_STORAGE_*` — not the managing token’s value.

### Managing token (created; IAM bootstrap resolved)

| Field | Value |
|---|---|
| Name | `dofek-terraform-r2-manage` |
| Token id (non-secret) | `ac888fe9c542f602fc419c29d28a64cc` |
| Account | `8e5b2f62ffe8ebdd48e725d325a6d51e` |
| Permissions | Account API Tokens Write + Workers R2 Storage Write (account scope only) |
| GH secret | `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` (names-only confirmed present) |
| Create path | Managed Cloudflare MCP (app-server `cloudflare-api`) + policy readback; value piped to `gh secret set` (stdin) |

Optional bearer check (no secret in logs): `GET /accounts/{id}/tokens/{token_id}/permission_groups` → **200** with the two Write groups. List Tokens on the **default** GH/Infisical `CLOUDFLARE_API_TOKEN` still returns **403 / 9109** — expected; those tokens are not Account API Tokens–capable and must stay that way for Traefik.

### Why not one full managing token (DNS + R2)

A prior path tried a single Terraform token that also needed **DNS Write**. Managed
MCP catalog for the creating caller showed DNS Write id
`4755a26eedb94da69e1066d98aa820be` with `is_selectable=false` (caller membership
subset — [create-via-api](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/),
[Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)).
**DNS elevation is not required** for the durable approach: keep the existing
default Cloudflare credential for DNS/existing resources; use the R2-only
aliased credential for Kafka TS. Zone DNS Settings Write is **not** a DNS record
CRUD substitute and is irrelevant to this split.

## B. Infisical CI — `KAFKA_TIERED_STORAGE_*` granted

| Field | Value |
|---|---|
| Privilege id | `9f804f06-05e2-45e8-b8b6-2b794c101b32` |
| Slug | `gha-kafka-ts-r2-secrets` |
| Permanent | yes (`isTemporary=false`) |
| Actions | `describeSecret`, `readValue`, `create`, `edit` on `secrets` |
| Conditions | `prod`, `/`, `secretName.$glob=KAFKA_TIERED_STORAGE_*` |
| CI identity | `46b66f72-0c77-4cfe-be1b-a43395e77be7` (membership still `viewer`) |
| Project | `54712f56-98a9-4531-9e97-0b588d2e5a88` |

[Additional privileges](https://infisical.com/docs/documentation/platform/access-controls/additional-privileges)
layer on roles. OIDC in `deploy-terraform` uses this identity. Grant ≠ apply
success until secrets are written by apply.

Re-check:
`GET /api/v2/identity-project-additional-privilege/9f804f06-05e2-45e8-b8b6-2b794c101b32`

## Enable sequence

1. ~~IAM bootstrap~~ **done** — `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` in GH; workflow wires
   `TF_VAR_cloudflare_terraform_r2_api_token` (fail-fast if empty). Default
   `CLOUDFLARE_API_TOKEN` retained for DNS/`storage.tf`.
2. `terraform apply` via normal deploy path (proves R2 Write + Account Tokens Write
   + Infisical write). **Not claimed done by this doc.**
3. Kafka TS qualification / broker cutover separate (Lane 87 + 3d:
   `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` when ready). Topic v2 cutover separate.
4. Infisical Traefik `CLOUDFLARE_API_TOKEN` stays. Do not merge R2 managing token
   into Infisical.

## Retired

- `enable_kafka_tiered_storage_r2` / count gates
- Unapplied Pulsar B2 IaC / Backblaze provider
- Single full-scope `CLOUDFLARE_TERRAFORM_API_TOKEN` / DNS-elevate bootstrap as the
  required path for Kafka TS (superseded by aliased R2 credential)
