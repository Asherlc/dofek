# Kafka tiered storage — R2 IaC (stock Cloudflare provider)

Dedicated R2 bucket + long-lived Object RW account token for Apache Kafka 4.4 +
Aiven RSM 1.2.0. Metric-stream JSONL archive and account-erasure ledger in
[`deploy/storage.tf`](../deploy/storage.tf) stay untouched.

**No TF apply / bucket create / key mint / deploy from this doc alone.**
Resources are always declared (no enable-flag). Infisical CI additional
privilege for `KAFKA_TIERED_STORAGE_*` is **granted** (see §B). Hold
`deploy-terraform` apply until the **managing** Terraform Cloudflare credential
(GitHub `CLOUDFLARE_API_TOKEN`) is proven to have Account API Tokens
Read/Write — still unverified.

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

## B. Infisical CI write for `KAFKA_TIERED_STORAGE_*` — **granted**

User approved **only** this new Kafka Infisical prefix grant. Root executed stock
[`POST /api/v2/identity-project-additional-privilege`](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create)
**SUCCESS**. No role PATCH. No further grant writes.

| Field | Value |
|---|---|
| Privilege id | `9f804f06-05e2-45e8-b8b6-2b794c101b32` |
| Slug | `gha-kafka-ts-r2-secrets` |
| Temporary | `false` (permanent) |
| Subject | `secrets` |
| Actions | `describeSecret`, `readValue`, `create`, `edit` |
| Conditions | `environment=prod`, `secretPath=/`, `secretName.$glob=KAFKA_TIERED_STORAGE_*`, `inverted=false` |
| CI identity | `46b66f72-0c77-4cfe-be1b-a43395e77be7` |
| Project id | `54712f56-98a9-4531-9e97-0b588d2e5a88` |
| Membership roles | still **only** `viewer` (unchanged) |

Verified by semantic GET readback
([Find by ID](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/find-by-id)
`GET /api/v2/identity-project-additional-privilege/9f804f06-05e2-45e8-b8b6-2b794c101b32`).
Initial key-order JSON mismatch was a verification artifact only — grant was
correct; no retry/additional write.

Platform citation: additional privileges layer scoped permissions on a machine
identity **on top of** its roles without replacing them —
[Additional privileges](https://infisical.com/docs/documentation/platform/access-controls/additional-privileges).
`deploy-terraform` already authenticates the Infisical provider with GitHub OIDC
against this same identity (`INFISICAL_MACHINE_IDENTITY_ID=46b66f72-…`). Per that
doc, the identity’s effective permissions include role + additional privilege.
**Do not claim Infisical secret write is runtime-proven** until a successful
`terraform apply` creates the `KAFKA_TIERED_STORAGE_*` secrets; grant presence ≠
apply success.

### Readonly re-check paths

```bash
# List
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege?identityId=46b66f72-0c77-4cfe-be1b-a43395e77be7&projectId=54712f56-98a9-4531-9e97-0b588d2e5a88" \
  | jq '.privileges[] | select(.slug=="gha-kafka-ts-r2-secrets") | {id, slug, isTemporary}'

# Get by id (canonical)
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege/9f804f06-05e2-45e8-b8b6-2b794c101b32" \
  | jq '.privilege | {id, slug, isTemporary, permissions}'
```

([List](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/list),
[Find by ID](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/find-by-id)).

Create body retained for audit (already POSTed — do not re-POST):

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

## C. Next: readonly CF managing-auth check (proposal — not executed)

**Goal:** Prove whether GitHub Actions secret `CLOUDFLARE_API_TOKEN` (the Terraform
managing credential) can list account-owned tokens — without printing secret
values, without merging diagnostic-only code, without blind GH rotation, without
MCP OAuth extraction. Root uses existing auth sources only.

**Readonly probe** ([List Tokens](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/list/)):

`GET https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens`

Optional second call (same auth class):
`GET …/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/permission_groups`
with plain query `name=Workers R2 Storage Bucket Item Write` /
`scope=com.cloudflare.edge.r2.bucket` (client will QueryEscape).

**How to run once (no maintained diagnostic artifact):**

1. Throwaway branch + disposable `workflow_dispatch` job that injects only
   `secrets.CLOUDFLARE_API_TOKEN` and `secrets.CLOUDFLARE_ACCOUNT_ID` (same names
   as [`deploy-terraform.yml`](../.github/workflows/deploy-terraform.yml)).
2. `curl` the List Tokens URL; log **only**
   `success`, HTTP status, and `errors[].{code,message}` (and optionally
   `result|length` if `success=true`). Never echo the Bearer, never dump token
   `id`/`name`/`value` fields.
3. Delete the branch / do not merge the job into steady-state workflows.

**Interpretation:**

| Result | Meaning | Next |
|---|---|---|
| **200** / `success=true` | GH managing token has Account API Tokens **Read or Write** | Data-source refresh likely OK; **Write** for create still only proven at apply |
| **403** / `9109` | Same gap as Infisical `CLOUDFLARE_API_TOKEN` | One-time dashboard Account API Tokens Edit bootstrap (§A); update the store(s) that fail — **do not** blind-rotate GH if identity vs Infisical is unknown |
| Other | Stop; report status + error code only | No apply |

Infisical `CLOUDFLARE_API_TOKEN` already failed this probe (**403/9109**). That
does **not** decide GH. Do not rotate GH until this check (or an equivalent
operator dashboard inspection of the managing token’s permissions by name)
completes.

## Enable sequence (remaining)

1. Execute §C readonly GH CF authority check (or operator dashboard equivalent).
2. If 403: one-time stock Account API Tokens Edit bootstrap for the **proven**
   managing store(s); re-run §C — no blind GH rotate.
3. After list **200**: `deploy-terraform` / `terraform apply` creates
   always-declared Kafka TS resources (first apply also proves Infisical write +
   CF Account Tokens Write).
4. Lane 87 + 3d provision `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` when ready (can be
   later). **Do not** rewrite prod `METRIC_STREAM_*` topic values until approved
   drained topic-v2 cutover.
5. Prod holds unchanged otherwise; no touch of lifecycle tiny-1 B2 fixture
   (Nov11 cleanup still owned).

## Retired

- `enable_kafka_tiered_storage_r2` / `count` gates (removed)
- `deploy/b2-pulsar-offload.tf` (never applied; no `PULSAR_OFFLOAD_B2_*` secrets created)
- `docs/b2-pulsar-offload-iac.md`, `docs/b2-pulsar-offload-broker-stack-hunks.md`
- `Backblaze/b2` provider + workflow `B2_APPLICATION_KEY_*` requirements

Original Codex B2 management key and `/tmp/b2-lifecycle-tiny-1/` remain untouched.
