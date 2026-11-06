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
(today `CI` is stock `viewer` only).

Those are Root-held authenticated calls with the already-private Codex-local
management key — official HTTP + `gh secret set` stdin. No maintained or ephemeral
custom bootstrap tool.

`infisical_project_role` / `infisical_project_identity` are **not** in the CI Terraform
apply path: CI cannot safely manage its own privilege without broader admin.

## Schema / route proof (read before any write)

Do **not** call legacy `…/identity-memberships/{id}`. Current Infisical OpenAPI for
US/EU cloud is:

| Op | Official path | Source |
| --- | --- | --- |
| GET membership | `/api/v1/projects/{projectId}/memberships/identities/{identityId}` | [get by identity id](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/get-by-id) |
| PATCH membership | `/api/v1/projects/{projectId}/memberships/identities/{identityId}` | [update identity membership](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/update-identity-membership) |
| LIST roles | `/api/v1/projects/{projectId}/roles` | [list project roles](https://infisical.com/docs/api-reference/endpoints/project-roles/list) |
| GET role by slug | `/api/v1/projects/{projectId}/roles/slug/{roleSlug}` | [get by slug](https://infisical.com/docs/api-reference/endpoints/project-roles/get-by-slug) |
| POST role | `/api/v1/projects/{projectId}/roles` | [create project role](https://infisical.com/docs/api-reference/endpoints/project-roles/create) |

Host for this project: `https://app.infisical.com` (same host CI uses for OIDC login).
OpenAPI servers list `https://us.infisical.com` / `https://eu.infisical.com`; paths are
identical.

`secrets` actions `describeSecret`, `readValue`, `create`, `edit` are first-class enums
in the create-role OpenAPI and in Infisical source
[`ProjectPermissionSecretActions`](https://github.com/Infisical/infisical/blob/main/backend/src/ee/services/permission/project-permission.ts)
(`DescribeSecret`, `ReadValue`, `Create`, `Edit`). `readValue` requires `describeSecret`
([project permissions](https://infisical.com/docs/internals/permissions/project-permissions)).

Condition keys `environment` / `secretPath` / `secretName` accept either a plain string
(exact match) **or** an operator object. `$glob` is a documented operator
([permissions overview](https://infisical.com/docs/internals/permissions/overview)) and is
in create-role OpenAPI + source `SecretConditionV2Schema.secretName` (`$EQ` / `$NEQ` /
`$IN` / `$GLOB`). Use plain strings for exact `prod` and `/`; use `$glob` only for the
`PULSAR_OFFLOAD_B2_*` name prefix.

## One-time Root steps (stock primitives only — review before run)

No dashboard. No secret values in chat. Secrets stay in Root private process env / stdin
pipes. Do not run until Root ACK of scopes below. No Terraform apply in this section.
No Cursor Infisical/GitHub secret writes.

Constants: project `54712f56-98a9-4531-9e97-0b588d2e5a88`, CI identity
`46b66f72-0c77-4cfe-be1b-a43395e77be7`, key name `dofek-terraform-b2-iac`, role slug
`gha-pulsar-offload-b2-secrets`.

Root auth prerequisites (private): B2 management key able to create keys; Infisical
Bearer with project role admin; `gh` authenticated to `Asherlc/dofek`.

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

Equivalent body:

```json
{
  "accountId": "{accountId}",
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
}
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

### 3. Infisical — read-only preflight (must succeed before any POST/PATCH)

Set `INFISICAL_TOKEN` privately. Base:

`INFISICAL_API=https://app.infisical.com/api/v1/projects/54712f56-98a9-4531-9e97-0b588d2e5a88`

**3a. Membership metadata** ([get by identity id](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/get-by-id)):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API}/memberships/identities/46b66f72-0c77-4cfe-be1b-a43395e77be7" \
  | tee /tmp/ci-membership.json >/dev/null
```

Collect every current role slug (preserve-all later):

```bash
jq -r '.identityMembership.roles[] | (.customRoleSlug // .role)' /tmp/ci-membership.json
```

Expect today’s membership to include `viewer`. If GET 404s on this path, **stop** — do not
retry a legacy `identity-memberships` URL.

**3b. Existing role permission shapes** ([list roles](https://infisical.com/docs/api-reference/endpoints/project-roles/list)):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API}/roles" \
  | tee /tmp/project-roles.json >/dev/null
jq '.roles[] | {slug, permissions}' /tmp/project-roles.json
```

Confirm live `permissions[]` objects use `subject` / `action` / optional `conditions`
matching the create OpenAPI before posting a new role.

**3c. Target slug** ([get by slug](https://infisical.com/docs/api-reference/endpoints/project-roles/get-by-slug)):

```bash
curl -sS -o /tmp/gha-role.json -w '%{http_code}' -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "${INFISICAL_API}/roles/slug/gha-pulsar-offload-b2-secrets"
```

- `200` → skip step 4 (role exists); still run step 5 if membership lacks the slug.
- `404` → proceed to step 4.
- anything else → **stop**.

### 4. Infisical — create narrow role (once; only after 3a–3c)

[Create project role](https://infisical.com/docs/api-reference/endpoints/project-roles/create)

```bash
curl -fsS -X POST -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  -H "Content-Type: application/json" \
  "${INFISICAL_API}/roles" \
  -d @- <<'EOF'
{
  "slug": "gha-pulsar-offload-b2-secrets",
  "name": "GHA Pulsar offload B2 secrets",
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

Exact payload above is the final create body. Plain-string `environment` / `secretPath`
are the documented exact-match form; `$glob` on `secretName` is the supported operator
form for the prefix.

### 5. Infisical — attach role; preserve every existing membership role

Build PATCH body from the GET in 3a (every existing slug + new slug if missing):

```bash
jq -n --slurpfile membership /tmp/ci-membership.json '
  ($membership[0].identityMembership.roles
    | map({role: (.customRoleSlug // .role)}))
  as $existing
  | ($existing + [{role: "gha-pulsar-offload-b2-secrets"}]
     | unique_by(.role))
  | {roles: .}
' | tee /tmp/ci-membership-patch.json >/dev/null
```

Example when GET returned only `viewer`:

```json
{
  "roles": [
    { "role": "viewer" },
    { "role": "gha-pulsar-offload-b2-secrets" }
  ]
}
```

If GET returned more roles, the `jq` output must include every one — never replace with
only viewer+new.

[Update identity membership](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/update-identity-membership):

```bash
curl -fsS -X PATCH -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  -H "Content-Type: application/json" \
  "${INFISICAL_API}/memberships/identities/46b66f72-0c77-4cfe-be1b-a43395e77be7" \
  -d @/tmp/ci-membership-patch.json
```

Re-GET the same membership URL; confirm `viewer` (and any prior roles) remain alongside
`gha-pulsar-offload-b2-secrets`.

## After Root completes 1–5 (held)

ACK → `deploy-terraform.yml` apply creates bucket, broker key, and Infisical secret
values automatically. Lifecycle track idle until ≥24h. No Codex key transfer into
CI/Cursor/prompts.
