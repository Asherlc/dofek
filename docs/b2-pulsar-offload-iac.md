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

## Why a custom bootstrap script is not needed

Application/resource setup is Terraform. The only thing Terraform cannot mint from
nothing is the **first** B2 credential used to talk to the B2 provider, plus a
**one-time** Infisical grant so machine identity `CI` can write `PULSAR_OFFLOAD_B2_*`
(today `CI` is stock `viewer` only — leave that membership and all existing secrets
unchanged until an approved Infisical path exists).

Those are Root-held authenticated calls — official HTTP + `gh secret set` stdin. No
maintained or ephemeral custom bootstrap tool.

`infisical_project_role` / `infisical_project_identity` are **not** in the CI Terraform
apply path: CI cannot safely manage its own privilege without broader admin.

## Blocker (recorded) — custom project roles unavailable on current plan

Root create-role call returned **HTTP 400**:

> Failed to create custom role due to plan RBAC restriction. Upgrade to Infisical
> Enterprise plan to create custom roles.

This is an **account plan** restriction, not a payload/schema failure. Official docs:
[custom roles are Enterprise](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls);
built-in roles (`admin` / `member` / `viewer` / `no-access`) remain on all plans.

**STOP:** do not retry role create payloads, do not assign custom role slugs, do not
upgrade to Enterprise for this, do not broaden `CI` to `member`/`admin`.

B2 parent key + GitHub Actions secret piping (sections below) are unaffected. Infisical
secret *write* grant for `CI` is **held** until an approved alternative.

Constants (unchanged): project `54712f56-98a9-4531-9e97-0b588d2e5a88`, CI identity
`46b66f72-0c77-4cfe-be1b-a43395e77be7`, key name `dofek-terraform-b2-iac`.

## Read-only: stock scoped options on current plan (no writes)

Investigated against Infisical platform docs / OpenAPI. No Cursor Infisical writes.

| Mechanism | Plan / docs | Fits “keep `viewer`, no broad grant, no paid upgrade”? |
| --- | --- | --- |
| Custom project role + attach | Enterprise (`plan.rbac`) — **blocked** (HTTP 400 above) | No |
| Built-in `member` / `admin` on `CI` | All plans | No — project-wide secret write |
| Built-in `no-access` + scoped grant | All plans | No — would change existing `viewer` membership |
| Folder-level access (`Edit` on a folder) | [Paid Pro feature](https://infisical.com/docs/documentation/platform/access-controls/folder-rbac); not recursive; grant is folder-role not secret-name glob | No without paid upgrade; `/` folder Edit would also cover every root secret, not only `PULSAR_OFFLOAD_B2_*` |
| Identity **additional privileges** (machine-identity API) | Documented stock alternative to creating a role ([additional privileges](https://infisical.com/docs/documentation/platform/access-controls/additional-privileges)); create/list OpenAPI under `/api/v2/identity-project-additional-privilege` ([create](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create), [list](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/list)). Not gated by the custom-role `plan.rbac` check that produced the HTTP 400 | **Yes candidate** — layers scoped `secrets` permissions on the existing identity without a custom role and without changing the `viewer` role assignment |

Read-only preflight Root can run anytime (does not change state):

```bash
# Existing membership roles (expect viewer; leave unchanged)
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "https://app.infisical.com/api/v1/projects/54712f56-98a9-4531-9e97-0b588d2e5a88/memberships/identities/46b66f72-0c77-4cfe-be1b-a43395e77be7" \
  | jq '.identityMembership.roles[] | (.customRoleSlug // .role)'

# Any additional privileges already on CI
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "https://app.infisical.com/api/v2/identity-project-additional-privilege?identityId=46b66f72-0c77-4cfe-be1b-a43395e77be7&projectId=54712f56-98a9-4531-9e97-0b588d2e5a88" \
  | jq '.privileges'
```

No existing stock custom role or folder grant path satisfies scoped write on this plan
without either Enterprise, Pro folder RBAC, or a broad built-in role.

## Proposed alternative (awaiting user approval — not implemented)

**Least machinery:** one Root `POST` to stock
[`/api/v2/identity-project-additional-privilege`](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create)
granting `CI` the same secret actions previously intended for the custom role, while
**keeping** project role `viewer` and leaving all existing secrets untouched:

```json
{
  "identityId": "46b66f72-0c77-4cfe-be1b-a43395e77be7",
  "projectId": "54712f56-98a9-4531-9e97-0b588d2e5a88",
  "slug": "gha-pulsar-offload-b2-secrets",
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

If that POST also returns a plan restriction, stop again and fall back to the next-least
machinery option (still needs explicit approval): Root-held Infisical secret upsert after
B2 Terraform apply (CI stays `viewer`; no Infisical write identity grant). Do **not**
implement either path until approved.

## One-time Root steps still valid (B2 + GH only)

No dashboard. No secret values in chat. No Cursor Infisical/GitHub secret writes.
Do not run Terraform apply for Infisical secrets until the grant path is approved.

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

## After B2/GH (1–2) and an approved Infisical grant

ACK → `deploy-terraform.yml` apply creates bucket, broker key, and Infisical secret
values automatically. Lifecycle track idle until ≥24h. No Codex key transfer into
CI/Cursor/prompts.

## Historical (do not run) — custom role packet

Superseded by the plan RBAC blocker. Kept only so reviewers see what was attempted:
`POST /api/v1/projects/{projectId}/roles` with slug `gha-pulsar-offload-b2-secrets`, then
`PATCH …/memberships/identities/{identityId}` preserving all roles. Official membership
routes remain
[`GET`/`PATCH /api/v1/projects/{projectId}/memberships/identities/{identityId}`](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/get-by-id)
(not legacy `…/identity-memberships/{id}`). Do not retry.
