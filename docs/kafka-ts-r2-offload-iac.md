# Kafka tiered storage — R2 IaC (stock Cloudflare provider)

Dedicated R2 bucket + long-lived Object RW account token for Apache Kafka 4.4 +
Aiven RSM 1.2.0. Metric-stream JSONL archive and account-erasure ledger in
[`deploy/storage.tf`](../deploy/storage.tf) stay untouched.

**No TF apply / bucket create / key mint from this doc alone.** Resources are
always declared. Infisical CI can write `KAFKA_TIERED_STORAGE_*` (privilege
granted). Hold apply until GitHub secret **`CLOUDFLARE_TERRAFORM_API_TOKEN`**
exists and `deploy-terraform.yml` is switched to it (workflow change waits on
names-only proof that the secret is present).

## Terraform owns

| Resource | Notes |
|---|---|
| `cloudflare_r2_bucket.kafka_ts_offload` | Name `dofek-kafka-ts-offload`; `prevent_destroy`; no Object Lock |
| `cloudflare_r2_bucket_lifecycle.kafka_ts_offload_abort_mpu` | Abort incomplete MPU after 1d only — **no** live object age expiry (Kafka/RSM GC) |
| `cloudflare_account_token.kafka_ts_offload_object_rw` | Bucket-scoped **Workers R2 Storage Bucket Item Write** |
| `infisical_secret` ×5 | `KAFKA_TIERED_STORAGE_{BUCKET,ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}` at `prod` `/` |

Providers: existing `cloudflare` `~> 5.0` + `infisical` `0.20.12`.

Sources:
[account_token](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/resources/account_token),
[account_api_token_permission_groups_list](https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/data-sources/account_api_token_permission_groups_list),
[Create Token API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/),
[Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[R2 tokens / S3 mapping](https://developers.cloudflare.com/r2/api/tokens/),
[API token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).

Permission-group `name` / `scope` in Terraform are **plain** strings (provider →
cloudflare-go `url.Values.Encode()` QueryEscapes; do not pre-encode `%20`).

## Runtime env

| Infisical key | Owner | Notes |
|---|---|---|
| `KAFKA_TIERED_STORAGE_*` (×5) | This IaC | Broker AWS default chain + RSM non-secret bucket/endpoint/region |
| `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` | Lane 87 + 3d | May provision later; before broker cutover |
| Infisical `CLOUDFLARE_API_TOKEN` | Traefik ACME only (`CF_DNS_API_TOKEN` in `deploy/stack.yml`) | **Unchanged** — DNS challenge only |
| Archive `R2_*` | Existing media/archive | **Do not reuse** for Kafka TS |

Also on broker when TS enabled:
`AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`,
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`.

Do **not** change prod Infisical `METRIC_STREAM_*` topic values until an approved
drained topic-v2 cutover.

## A. One-time Terraform managing token (operator)

Existing Infisical and GitHub `CLOUDFLARE_API_TOKEN` both lack Account API Tokens
access (`GET /accounts/{id}/tokens` → **403 / 9109**). Do **not** widen those
tokens (Traefik must not receive Account API Tokens Edit). Create a **dedicated**
account-owned token and store it **only** in GitHub Actions as
`CLOUDFLARE_TERRAFORM_API_TOKEN`.

Account-owned tokens support DNS, R2, and Zone/Domain Management
([compatibility matrix](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)).
Child Kafka Object RW is minted later by Terraform — not by this bootstrap token’s
value in the broker.

### Checklist (dashboard)

Requires Super Administrator or API Token Provisioning
([Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)).

1. Open **Manage account → Account API Tokens → Create Token** (or the prefill URL below).
2. Name: `dofek-terraform-manage`.
3. Permissions:

| Permission (UI) | Scope |
|---|---|
| Account → **Account API Tokens** → Edit | This account |
| Account → **Workers R2 Storage** → Edit | This account |
| Zone → **Zone** → Edit | **Only** `dofek.fit`, `dofek.live` |
| Zone → **Zone** → Read | **`asherlc.com`** (for `data.cloudflare_zone.asherlc_com` name filter; DNS Edit alone does not list zones) |
| Zone → **DNS** → Edit | `dofek.fit`, `dofek.live`, `asherlc.com` |

Zones (committed import ids): `dofek.fit` `a744a251…`, `dofek.live` `04dc9fc0…`,
`asherlc.com` `17402b9a…`; account `8e5b2f62…` (`deploy/imports.tf`).

4. Create token → copy secret once.
5. Add GitHub Actions secret **`CLOUDFLARE_TERRAFORM_API_TOKEN`**:
   [New repository secret](https://github.com/Asherlc/dofek/settings/secrets/actions/new)
   (or `gh secret set CLOUDFLARE_TERRAFORM_API_TOKEN` via stdin — never paste into
   chat/logs).
6. Optional verify with that bearer only: `GET /accounts/{id}/tokens` → **200**
   means Read **or** Write; Write for create is proven only at apply.
7. Leave Infisical `CLOUDFLARE_API_TOKEN` (Traefik) untouched. Leave old GitHub
   `CLOUDFLARE_API_TOKEN` until the workflow points at the new secret, then retire
   after an unused-name audit.

### Prefill URL (permissions only — not a secret)

Official account-token template form
([template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)):

https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22account_api_tokens%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&name=dofek-terraform-manage

Prefills permission **keys** only. Zone include-lists are set in the form after open
(account-token templates do **not** take `zoneId` query params).

### UI zone include vs minimal policy

Account-token template docs: resource scoping is configured **in the create form**,
not in the URL. The dashboard commonly uses **one shared Zone Resources include
list** for all zone-scoped permissions on that token. If so, including all three
zones for DNS while needing Zone Edit only on two can **also** grant Zone Edit on
`asherlc.com` — broader than the table above.

**Minimal precise grant** (separate policies / resource maps) is available via the
[Create Token API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/)
with multiple `policies` entries (Zone Edit → fit/live only; Zone Read →
asherlc.com only; DNS Edit → all three; account perms → account). Prefer that if
the UI cannot split zone includes per permission. Do not invent a second provider
or custom CLI for this.

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
success until secrets are written.

Re-check:
`GET /api/v2/identity-project-additional-privilege/9f804f06-05e2-45e8-b8b6-2b794c101b32`

## Enable sequence

1. Operator completes §A (CF create → GH `CLOUDFLARE_TERRAFORM_API_TOKEN`).
2. Names-only proof secret exists → then switch
   [`deploy-terraform.yml`](../.github/workflows/deploy-terraform.yml) to
   `secrets.CLOUDFLARE_TERRAFORM_API_TOKEN` (**no** fallback to
   `CLOUDFLARE_API_TOKEN`).
3. `terraform apply` via normal deploy path (proves CF Write + Infisical write).
4. Lane 87 + 3d: `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` when ready. Topic v2 cutover
   separate.
5. Retire unused GitHub `CLOUDFLARE_API_TOKEN` after audit. Infisical Traefik token
   stays.

## Retired

- `enable_kafka_tiered_storage_r2` / count gates
- Unapplied Pulsar B2 IaC / Backblaze provider
