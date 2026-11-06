# Pulsar offload B2 Terraform

Backblaze B2 holds Pulsar BookKeeper sealed-ledger offload. Cloudflare R2 keeps
metric-stream archive and account-erasure ledger unchanged.

## Terraform owns (stock — `deploy/`)

| Resource | Provider |
| --- | --- |
| Private bucket `dofek-pulsar-offload`, lifecycle, broker application key | `Backblaze/b2` `0.14.1` |
| `PULSAR_OFFLOAD_B2_*` at `/` | `infisical/infisical` `0.20.12` |

HCP `dofek`/`dofek` is `execution_mode=local`. GHA supplies dedicated IaC parent env
`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` and Infisical OIDC JWT after `terraform init`.

Broker stack hunks (after secrets exist): [b2-pulsar-offload-broker-stack-hunks.md](./b2-pulsar-offload-broker-stack-hunks.md).
Do **not** merge those hunks into dirty `deploy/stack.yml` until Infisical has the five
runtime secrets from Terraform apply.

## Readiness (committed TF / workflow / docs)

| Item | Status |
| --- | --- |
| `deploy/b2-pulsar-offload.tf` bucket + 1d hide→delete / 1d MPU cancel + broker key + five `infisical_secret` | Committed; R2 archive/erasure stay in `storage.tf` only |
| `deploy/main.tf` providers `Backblaze/b2` `0.14.1`, `infisical/infisical` `0.20.12`; empty `provider "b2"` / `provider "infisical"` (env/OIDC) | Committed |
| `deploy/.terraform.lock.hcl` pins both providers | Committed |
| `.github/workflows/deploy-terraform.yml` requires `B2_APPLICATION_KEY_ID`/`B2_APPLICATION_KEY`, OIDC JWT **after** `terraform init`, masks JWT, never prints plan/apply secret JSON | Committed; `actionlint` clean |
| `terraform fmt -check` on `b2-pulsar-offload.tf` + `main.tf` | Pass (Terraform 1.10 container) |
| Five runtime Infisical secrets | Exact contract below — TF ↔ stack hunks match |
| Identity additional-privilege POST | **Blocked on user pivot approval** (packet ready; no write) |
| B2 IaC parent → GH secrets | Packet ready; Root executes after approval; no Cursor write |
| Production holds / Deploy Web disabled | Unchanged by this lane |

### Five runtime secrets (stock aws-s3 broker)

| Infisical key (`prod` `/`) | Source |
| --- | --- |
| `PULSAR_OFFLOAD_B2_BUCKET` | TF `b2_bucket.pulsar_offload.bucket_name` → `dofek-pulsar-offload` |
| `PULSAR_OFFLOAD_B2_ENDPOINT` | TF local `https://s3.us-west-004.backblazeb2.com` |
| `PULSAR_OFFLOAD_B2_REGION` | TF local `us-west-004` |
| `PULSAR_OFFLOAD_B2_KEY_ID` | TF broker application key id |
| `PULSAR_OFFLOAD_B2_APP_KEY` | TF broker application key secret |

Broker maps them to `managedLedgerOffload*` / `s3ManagedLedgerOffloadCredentialId|Secret`
(see stack hunks). **Credential mode for production hunks:** explicit Infisical-backed
id/secret env — not empty-static AWS default-chain lab mode. Never echo key id/secret
into chat, workflow logs, `docker service inspect`, or compose dumps (`deploy-terraform.yml`
already forbids printing TF/B2/Infisical credential material).

### Lifecycle experiment schedule (tiny-1 — metadata only)

Artifacts: `/tmp/b2-lifecycle-tiny-1/` (`T0.json`, `CHECK_MATRIX.json`, `ownership.json`).
Cursor asserts; Root (not archived b1) runs privileged B2 metadata APIs. Zero GetObject.

| Gate | UTC | Class |
| --- | --- | --- |
| T0 | `2026-11-06T18:49:03.649Z` | seed assert (done) |
| Obs #1 | `~2026-11-06T19:32Z` | `OBSERVATION_ONLY` (done; inventory ≡ T0) |
| ≥24h | `2026-11-07T18:49:03.649Z` | `OBSERVE_ELIGIBLE` — **next**; wait clock |
| ≥48h | `2026-11-08T18:49:03.649Z` | `OBSERVATION_CHECKPOINT` |
| Cleanup deadline | `2026-11-11T18:49:02.531Z` | Root cleanup if still unclean → Cursor verify zeros |

Paseo heartbeat `eac63e16` (`b2-lifecycle-tiny-1 checkpoints`, cron `50 18 * * *` UTC,
next `2026-11-07T18:50:00Z`, expires `2026-11-12`) recreates the missing cadence so
checks fire before the Nov 11 deadline. Until ≥24h: **do not** request Root metadata.

## Why a custom bootstrap script is not needed

Application/resource setup is Terraform. The only thing Terraform cannot mint from
nothing is the **first** B2 credential used to talk to the B2 provider, plus a
**one-time** Infisical grant so machine identity `CI` can write `PULSAR_OFFLOAD_B2_*`
(today `CI` is stock `viewer` only — **preserve `viewer` and every current membership
role**; do not PATCH membership roles for this grant).

Those are Root-held authenticated calls — official HTTP + `gh secret set` stdin. No
maintained or ephemeral custom bootstrap tool.

`infisical_project_role` / `infisical_project_identity` are **not** in the CI Terraform
apply path: CI cannot safely manage its own privilege without broader admin.

## Blocker (recorded) — custom project roles unavailable on current plan

Root create-role call returned **HTTP 400**:

> Failed to create custom role due to plan RBAC restriction. Upgrade to Infisical
> Enterprise plan to create custom roles.

**STOP** custom-role retries / `member`/`admin` broadening / plan upgrade.

Constants: project `54712f56-98a9-4531-9e97-0b588d2e5a88`, CI identity
`46b66f72-0c77-4cfe-be1b-a43395e77be7`, key name `dofek-terraform-b2-iac`, privilege
slug `gha-pulsar-offload-b2-secrets`.

## Infisical path — identity additional privilege (stock)

### Gate evidence

| Check | Result |
| --- | --- |
| Custom role `plan.rbac` | Blocked (HTTP 400 above) |
| Additional-privilege `plan.rbac` | Not checked on create path (Infisical source) |
| `project.isLegacyAdditionalPrivilegesEnabled` | **Root read-only GET confirmed `true`** for this project |
| Target API | [`POST /api/v2/identity-project-additional-privilege`](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create) |

Privilege layers on the existing identity **without** changing project roles. Leave
`viewer` (and any other current roles) untouched.

**User pivot approval pending — Cursor/Root must not POST until approved.** Packet below
is the exact reviewed body + read-only preflight/idempotent lookup/readback only.

### Auth

Grantor: Bearer JWT or identity access token with project permission to `Edit` on
subject `identity` ([create route auth](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create)).
Host for this project: `https://app.infisical.com`.

### A. Read-only preflight (safe anytime)

Base:

```bash
INFISICAL_API_V1=https://app.infisical.com/api/v1
INFISICAL_API_V2=https://app.infisical.com/api/v2
PROJECT_ID=54712f56-98a9-4531-9e97-0b588d2e5a88
CI_IDENTITY_ID=46b66f72-0c77-4cfe-be1b-a43395e77be7
PRIVILEGE_SLUG=gha-pulsar-offload-b2-secrets
```

**A1. Legacy flag** (already `true`; re-check if desired):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V1}/projects/${PROJECT_ID}" \
  | jq '.project.isLegacyAdditionalPrivilegesEnabled'
```

**A2. Membership roles — expect `viewer`; do not PATCH:**

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V1}/projects/${PROJECT_ID}/memberships/identities/${CI_IDENTITY_ID}" \
  | tee /tmp/ci-membership.json >/dev/null
jq -r '.identityMembership.roles[] | (.customRoleSlug // .role)' /tmp/ci-membership.json
```

**A3. Idempotent privilege lookup** ([list](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/list) — metadata only, no `permissions`):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege?identityId=${CI_IDENTITY_ID}&projectId=${PROJECT_ID}" \
  | tee /tmp/ci-privileges.json >/dev/null
jq --arg slug "${PRIVILEGE_SLUG}" '
  .privileges
  | map(select(.slug == $slug))
  | .[0] // empty
' /tmp/ci-privileges.json | tee /tmp/ci-privilege-hit.json >/dev/null
```

- Non-empty hit → **skip create**; take `.id` for readback (B).
- Empty → create is still needed after approval (C). Duplicate slug on POST returns
  BadRequest *Additional privilege with name … exists* (Infisical service).

**A4. Permissions readback** when hit exists ([find by id](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/find-by-id)):

```bash
PRIVILEGE_ID=$(jq -r '.id' /tmp/ci-privilege-hit.json)
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege/${PRIVILEGE_ID}" \
  | jq '.privilege | {id, slug, isTemporary, permissions}'
```

Assert `permissions` match the create body in C (subject `secrets`, actions only
`describeSecret`/`readValue`/`create`/`edit`, conditions `environment`=`prod`,
`secretPath`=`/`, `secretName.$glob`=`PULSAR_OFFLOAD_B2_*`). Re-check A2 — `viewer`
unchanged.

### B. Exact create body (do not POST until user approves)

OpenAPI **requires** `identityId`, `projectId`, `permissions`, and nested `type`
(platform docs sample omits `type`; live schema does not — include it).

[`POST /api/v2/identity-project-additional-privilege`](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create)

```json
{
  "identityId": "46b66f72-0c77-4cfe-be1b-a43395e77be7",
  "projectId": "54712f56-98a9-4531-9e97-0b588d2e5a88",
  "slug": "gha-pulsar-offload-b2-secrets",
  "type": { "isTemporary": false },
  "permissions": [
    {
      "subject": "secrets",
      "action": ["describeSecret", "readValue", "create", "edit"],
      "conditions": {
        "environment": "prod",
        "secretPath": "/",
        "secretName": { "$glob": "PULSAR_OFFLOAD_B2_*" }
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
  "slug": "gha-pulsar-offload-b2-secrets",
  "type": { "isTemporary": false },
  "permissions": [
    {
      "subject": "secrets",
      "action": ["describeSecret", "readValue", "create", "edit"],
      "conditions": {
        "environment": "prod",
        "secretPath": "/",
        "secretName": { "$glob": "PULSAR_OFFLOAD_B2_*" }
      }
    }
  ]
}
EOF
```

No membership PATCH. No other actions/subjects. No temporary privilege (`type.isTemporary`
must be `false`).

### C. Post-create readback (after approved POST only)

```bash
# From create response:
PRIVILEGE_ID=$(jq -r '.privilege.id' <<<"${CREATE_PRIVILEGE_JSON}")
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API_V2}/identity-project-additional-privilege/${PRIVILEGE_ID}" \
  | jq '.privilege | {id, slug, isTemporary, permissions}'
# Confirm membership still viewer-only (or prior roles unchanged):
jq -r '.identityMembership.roles[] | (.customRoleSlug // .role)' /tmp/ci-membership.json
# Re-GET membership if needed — must not have gained member/admin/custom roles.
```

Optional slug readback needs `projectSlug` query param
([find by slug](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/find-by-slug));
prefer find-by-id above (project UUID already known).

## One-time Root steps still valid (B2 + GH only)

No dashboard. No secret values in chat. No Cursor Infisical/GitHub secret writes.
Do not run Terraform apply for Infisical secrets until the privilege grant is approved
and applied.

Root auth prerequisites (private): B2 management key able to create keys;
`gh` authenticated to `Asherlc/dofek`.

### 1. B2 — create dedicated IaC parent key

Capabilities (7): `listBuckets`, `readBuckets`, `writeBuckets`, `deleteBuckets`,
`listKeys`, `writeKeys`, `deleteKeys`. (`writeKeys` is account-wide.)

If `b2_list_keys` already shows name `dofek-terraform-b2-iac`, **stop** (no delete/rotate).

Authorize (management key only in Root env):

```http
GET https://api.backblazeb2.com/b2api/v3/b2_authorize_account
Authorization: Basic base64(keyId:key)
```

Create ([b2_create_key v4](https://www.backblaze.com/apidocs/b2-create-key)) and keep the
JSON response in a private shell variable (do not print):

```bash
CREATE_KEY_JSON=$(curl -fsS -X POST "${API_URL}/b2api/v4/b2_create_key" \
  -H "Authorization: ${AUTHORIZATION_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "'"${ACCOUNT_ID}"'",
    "keyName": "dofek-terraform-b2-iac",
    "capabilities": [
      "listBuckets",
      "readBuckets",
      "writeBuckets",
      "deleteBuckets",
      "listKeys",
      "writeKeys",
      "deleteKeys"
    ]
  }')
```

### 2. GitHub Actions secrets (API response → `gh` stdin — no human paste)

`gh secret set` reads the secret value from stdin when `--body` is omitted
([gh secret set](https://cli.github.com/manual/gh_secret_set)). Pipe fields from the
create-key JSON directly (never `--body`, never print values):

```bash
jq -r '.applicationKeyId' <<<"${CREATE_KEY_JSON}" | gh secret set B2_APPLICATION_KEY_ID
jq -r '.applicationKey' <<<"${CREATE_KEY_JSON}" | gh secret set B2_APPLICATION_KEY
unset CREATE_KEY_JSON
```

## Root execute order (after user approvals — Cursor does not run)

1. **Approve** identity additional-privilege pivot → Root runs A preflight → B POST → C
   readback (preserve `viewer`).
2. **Approve** B2 IaC parent → Root runs B2 create-key (7 caps) → pipe to
   `gh secret set` stdin (sections 1–2 above). Stop if key name exists.
3. Root ACK → `deploy-terraform.yml` apply (bucket, broker key, five Infisical secrets).
4. Only then review/merge [broker stack hunks](./b2-pulsar-offload-broker-stack-hunks.md)
   into `deploy/stack.yml` (separate from dirty shared stack until that review).

No Codex management key into CI/Cursor/prompts. Lifecycle ≥24h observation is independent
of apply; wait the clock for that gate.

## Exact Root metadata request (only when a lifecycle gate is due)

Not due before `2026-11-07T18:49:03.649Z`. When due, Root returns sanitized JSON only
(`objectBodyDownloads=0`; never GetObject; never archived b1):

- Bucket `dofek-pulsar-b2-lc-20261106t184700z` / id `af1b54eb3312bd2ea1130015`
- Prefix `lc/20261106t184700z/`
- Endpoint `https://s3.us-west-004.backblazeb2.com` / region `us-west-004`
- Ops: ListBucketLifecycleConfiguration (or native equivalent); ListObjectVersions
  (paginate); HeadObject `live/keep`, `hide/victim`, `control/victim`;
  ListMultipartUploads (paginate)
- Return: `observedAt`, `rules[]`, `versions[]`, `deleteMarkers[]`, `heads[]`,
  `unfinishedUploads[]`, `objectBodyDownloads=0`

## Historical (do not run) — custom role packet

Superseded by plan RBAC blocker. Membership routes remain
[`GET`/`PATCH …/memberships/identities/{identityId}`](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/get-by-id).
Do not retry role create.
