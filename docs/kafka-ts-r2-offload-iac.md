# Kafka tiered storage — R2 IaC (stock Cloudflare provider)

Dedicated R2 bucket + long-lived Object RW account token for Apache Kafka 4.4 +
Aiven RSM 1.2.0. Metric-stream JSONL archive and account-erasure ledger in
[`deploy/storage.tf`](../deploy/storage.tf) stay untouched.

**No TF apply / bucket create / key mint / deploy / Infisical grant from this
doc alone.** Resources are always declared (no enable-flag). Hold
`deploy-terraform` apply until Cloudflare Account API Tokens Write is available
on the **managing** Terraform credential and the Infisical CI privilege below
is granted.

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

### Permission-group filter encoding (provider 5.19)

Use **plain** `name` / `scope` strings in Terraform:

```hcl
name  = "Workers R2 Storage Bucket Item Write"
scope = "com.cloudflare.edge.r2.bucket"
```

Primary sources (not the registry blurb alone):

1. Provider passes `name`/`scope` unchanged into list params —
   [`list_data_source_model.go` @ v5.19.0](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.19.0/internal/services/account_api_token_permission_groups/list_data_source_model.go).
2. cloudflare-go serializes query params via `URLQuery()` → `url.Values` then
   `Encode()` (standard `QueryEscape`) —
   [`tokenpermissiongroup.go`](https://github.com/cloudflare/cloudflare-go/blob/main/accounts/tokenpermissiongroup.go),
   [`requestconfig`](https://github.com/cloudflare/cloudflare-go/blob/main/internal/requestconfig/requestconfig.go)
   (`body.URLQuery().Encode()`).

Pre-encoding spaces as `%20` would become `%2520` on the wire. The data-source
schema text “must be URL-encoded” is OpenAPI-generated and conflicts with that
client path — prefer the Go encode behavior.

## Runtime env contracts

### Lane-87 owns (with 3d stack wiring) — provision before merge when ready

| Infisical key | Owner | Notes |
|---|---|---|
| `KAFKA_TIERED_STORAGE_*` (×5) | Lane 87 IaC (`infisical_secret` above) | Broker AWS default chain + RSM non-secret bucket/endpoint/region |
| `KAFKA_CLUSTER_ID` | Lane 87 + 3d | New Kafka cluster identity; may be provisioned later; required by kafka service env before broker cutover |
| `KAFKA_BROKERS` | Lane 87 + 3d | Canonical bootstrap string; app/sink/archive read this — **no** `REDPANDA_`/`PULSAR_` alias |

Also required on broker when TS enabled (stock Phase F proof):
`AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`,
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`.

Never set `KAFKA_RSM_CONFIG_STORAGE_AWS_ACCESS_KEY_ID` / `_SECRET` / `_SESSION_TOKEN`
static RSM fields. Never reuse archive `R2_ACCESS_KEY_*` or erasure ledger keys.
Stack/runtime wiring of broker dotenv is **3d-owned** with lane-87 for the keys above.

### Topic v2 cutover (explicit — do not do now)

| Keys | Rule |
|---|---|
| Existing prod Infisical `METRIC_STREAM_*` topic values (live/history/legacy / related v1 generation) | **Do not change now.** Changing them without an approved drained cutover can make current main services write the wrong cluster generation. |
| Topic **v2** names + producer/sink switch | Separate, explicit drained cutover only after approval. Document sequencing elsewhere; this IaC does not retarget topics. |

New `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` (and later `KAFKA_TIERED_STORAGE_*`) **may** be added as additional Infisical keys without rewriting current `METRIC_STREAM_*` topic values.

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

### Observed gap (readonly probes — no writes)

| Probe | Credential | Result |
|---|---|---|
| `GET /user/tokens/permission_groups` | Infisical **`CLOUDFLARE_API_TOKEN`** | **403 / 9109 Unauthorized** (prior) |
| `GET /accounts/{id}/tokens` | Infisical **`CLOUDFLARE_API_TOKEN`** | **403 / 9109 Unauthorized** (current local Root probe) |

That proves **this Infisical secret** lacks Account API Tokens Read/Write.

GitHub Actions secret `CLOUDFLARE_API_TOKEN` (feeds `TF_VAR_cloudflare_api_token` + stack `CF_DNS_API_TOKEN`) is a **separate store**. Its value is not readable here and **may differ**. Do **not** claim the GH secret lacks Account Tokens permission, and do **not** rotate/replace it, until an operator proves whether it is the same material as Infisical `CLOUDFLARE_API_TOKEN` (or separately probes GH/TF auth with a list-capable call).

### Configured CF operator auth sources (names only)

| Name | Where configured | Role today |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Infisical `prod` `/` | Operator/REST preflight — Account Tokens list **403/9109** |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret → TF + `CF_DNS_API_TOKEN` | TF Cloudflare provider + DNS — **value unread; may differ from Infisical** |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret → `TF_VAR_cloudflare_account_id` | Account id only |
| `R2_ACCESS_KEY_ID` | Infisical `prod` `/` | Archive/media S3 access key id (manual dashboard) |
| `R2_SECRET_ACCESS_KEY` | Infisical `prod` `/` | Archive/media S3 secret |
| `R2_ENDPOINT` | Infisical `prod` `/` | Archive/media S3 endpoint |

Do **not** reuse `R2_*` as Kafka TS broker creds or as Account Token mint parents. Lab temp-access-credentials remain lab-only — **forbidden** for prod bootstrap / renewal / runtime parent fallback.

Codex may have an authenticated Cloudflare MCP (`https://mcp.cloudflare.com/mcp`); that session is not available as a Root tool and OAuth material will not be extracted. Prefer stock operator paths below.

### Minimal higher-privileged bootstrap (stock interactive — only if necessary)

Use only after proving the **managing** TF credential (likely GH `CLOUDFLARE_API_TOKEN`, once identity vs Infisical is established) cannot list/create account tokens:

1. Operator with Super Administrator **or** API Token Provisioning opens Cloudflare dashboard → **Manage account → Account API Tokens → Create Token**
   ([Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
   [Create tokens via API — generating the initial token](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)).
2. Grant at least **Account → Account API Tokens → Edit**, plus whatever Zone/DNS/R2 Storage Edit the Terraform path already requires.
3. Update the **confirmed managing** store (GH and/or Infisical) only after identity proof — do not blind-rotate GH.
4. Verify `GET /accounts/{id}/tokens` returns **200**, then permission-groups list for `Workers R2 Storage Bucket Item Write` with scope `com.cloudflare.edge.r2.bucket`.
5. Child Object RW token is **only** created by Terraform `cloudflare_account_token.kafka_ts_offload_object_rw`. Broker receives child S3 mapping via Infisical `KAFKA_TIERED_STORAGE_*` — never the managing Bearer, never temp-access parent, never custom renewal.

Forbidden: DIY JWT signer, temp-cred renewal service, runtime parent fallback, extracting MCP OAuth, inventing a second cloud credential framework.

## B. Infisical CI write for `KAFKA_TIERED_STORAGE_*` (grant pending review)

| Item | Value |
|---|---|
| CI identity | `46b66f72-0c77-4cfe-be1b-a43395e77be7` (stock `viewer`) |
| Project id | `54712f56-98a9-4531-9e97-0b588d2e5a88` |
| Custom project roles | **Blocked** (`plan.rbac` / Enterprise) — do not retry |
| Pulsar privilege slug `gha-pulsar-offload-b2-secrets` | **Obsolete** — never POST |
| Needed slug | `gha-kafka-ts-r2-secrets` |
| Create API | [`POST /api/v2/identity-project-additional-privilege`](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create) |
| Grant | Operator only after approval of the exact body below — no POST from this lane yet |

Preserve `viewer` membership; do not PATCH roles for this grant.

### Exact create body (do not POST until approved)

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

### Readonly list / get paths (review before/after)

Base: `${INFISICAL_API_V2}` = `https://app.infisical.com/api/v2` (or org host).

**List privileges for CI identity in project**
([List](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/list)):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege?identityId=46b66f72-0c77-4cfe-be1b-a43395e77be7&projectId=54712f56-98a9-4531-9e97-0b588d2e5a88" \
  | jq '.privileges'
```

**Get by id** after create
([Find by ID](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/find-by-id)):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege/${PRIVILEGE_ID}" \
  | jq '.privilege | {id, slug, isTemporary, permissions}'
```

**Get by slug** (needs project **slug**, not id)
([Find by slug](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/find-by-slug)):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege/slug/gha-kafka-ts-r2-secrets?identityId=46b66f72-0c77-4cfe-be1b-a43395e77be7&projectSlug=${INFISICAL_PROJECT_SLUG}" \
  | jq '.privilege | {id, slug, isTemporary, permissions}'
```

Assert: slug `gha-kafka-ts-r2-secrets`, `isTemporary=false`, glob `KAFKA_TIERED_STORAGE_*`, actions only `describeSecret`/`readValue`/`create`/`edit`; membership still `viewer`.

## Enable sequence (after gates)

1. Prove whether GH `CLOUDFLARE_API_TOKEN` equals Infisical `CLOUDFLARE_API_TOKEN` (or separately whether GH/TF can `GET /accounts/{id}/tokens`). Upgrade managing auth only if that probe fails.
2. Approve + POST Infisical packet `gha-kafka-ts-r2-secrets`; verify list/get.
3. Normal `deploy-terraform` / `terraform apply` creates always-declared Kafka TS resources.
4. Lane 87 + 3d provision `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` when ready (can be later); wire broker dotenv. **Do not** rewrite prod `METRIC_STREAM_*` topic values until approved drained topic-v2 cutover.
5. No recreate of lab disposable bucket names; no touch of lifecycle tiny-1 B2 fixture (Nov11 cleanup still owned).

## Retired

- `enable_kafka_tiered_storage_r2` / `count` gates (removed)
- `deploy/b2-pulsar-offload.tf` (never applied; no `PULSAR_OFFLOAD_B2_*` secrets created)
- `docs/b2-pulsar-offload-iac.md`, `docs/b2-pulsar-offload-broker-stack-hunks.md`
- `Backblaze/b2` provider + workflow `B2_APPLICATION_KEY_*` requirements

Original Codex B2 management key and `/tmp/b2-lifecycle-tiny-1/` remain untouched.
