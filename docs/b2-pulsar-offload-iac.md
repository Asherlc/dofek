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

Causal match in Infisical source (`licenseService.getPlan` → `!plan?.rbac`): same message
string. Official docs: [custom roles are Enterprise / Advanced-tier RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls);
pricing table lists **custom roles / multi-role / temporary access** as Advanced+, and
**Access controls (RBAC/ABAC)** as Pro+ ([pricing](https://infisical.com/pricing)).

**STOP:** do not retry role create payloads, do not assign custom role slugs, do not
upgrade plans for this, do not broaden `CI` to `member`/`admin`. No pivot approved.

Constants (unchanged): project `54712f56-98a9-4531-9e97-0b588d2e5a88`, CI identity
`46b66f72-0c77-4cfe-be1b-a43395e77be7`, key name `dofek-terraform-b2-iac`.

## Verified (read-only): `POST /api/v2/identity-project-additional-privilege`

Sources inspected (no POST / no probe / no write from Cursor):

| Question | Evidence |
| --- | --- |
| Same `plan.rbac` gate as custom roles? | **No.** Create path is `backend/src/ee/routes/v2/identity-project-additional-privilege-router.ts` → `additionalPrivilege.createAdditionalPrivilege` → project factory guard. Neither the router nor `additional-privilege-service.ts` nor `project-additional-privilege-factory.ts` calls `licenseService.getPlan` / checks `plan.rbac`. The custom-role HTTP 400 string exists only on role create/update paths. |
| Hard availability gate? | **Yes — project flag, not plan.rbac.** On create, if `!project.isLegacyAdditionalPrivilegesEnabled`, Infisical throws BadRequest: *Additional privileges are not available for project '{name}'. Use project roles or folder access controls instead.* (`project-additional-privilege-factory.ts` `onCreateAdditionalPrivilegesGuard`). |
| Default / migration for that flag? | Schema default **`false`** (`projects.ts`). Migration `20260820120000_add-legacy-additional-privileges-enabled-to-project.ts` adds the column default false, then `UPDATE … SET "isLegacyAdditionalPrivilegesEnabled" = true` for **then-existing** rows only. Projects created afterward stay false unless changed. |
| Permission schema? | Body `permissions` = `ProjectPermissionV2Schema.array()` (same CASL v2 schema as project roles), refined by `checkForInvalidPermissionCombination`. Supports `secrets` actions including `describeSecret` / `readValue` / `create` / `edit` and condition keys `environment` / `secretPath` / `secretName` with `$glob` ([create OpenAPI](https://infisical.com/docs/api-reference/endpoints/identity-specific-privilege/v2/create); [project permissions](https://infisical.com/docs/internals/permissions/project-permissions)). |
| Auth applicability? | Route `onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN])`. Handler forces `actorType: IDENTITY` and `actorId: body.identityId` — **machine-identity target only** on this v2 API (user privileges are UI-only per [additional privileges docs](https://infisical.com/docs/documentation/platform/access-controls/additional-privileges)). Grantor needs project permission to `Edit` on subject `identity` (plus privilege-boundary checks). |
| Platform docs vs code? | Docs still describe additional privileges as the “without creating a new role” path. Code treats them as **legacy** and redirects disabled projects to **project roles** (blocked here) or **folder access** ([folder RBAC is Pro paid](https://infisical.com/docs/documentation/platform/access-controls/folder-rbac); folder roles are not secret-name glob and are not recursive). |

### Feasibility on current plan (no pivot)

Until Root confirms with a **read-only** project GET that
`isLegacyAdditionalPrivilegesEnabled === true` for
`54712f56-98a9-4531-9e97-0b588d2e5a88`, additional privileges are **not** a verified viable
automated path. Flag is exposed on `SanitizedProjectSchema` (includes
`isLegacyAdditionalPrivilegesEnabled`) via stock get-project responses.

If that flag is **false**, Infisical’s own create error points only at custom roles
(already plan-blocked) or folder access (paid Pro, no `PULSAR_OFFLOAD_B2_*` name glob on
`/`). In that case there is **no** verified Infisical stock mechanism that preserves
prefix scope on the current plan without a paid upgrade or a broad built-in role.

**No pivot proposed for approval.** Do not POST additional privileges. Do not implement
Root manual secret upsert. Do not change `viewer` or existing secrets.

Optional Root read-only check (evidence only; not a grant):

```bash
curl -fsS -H "Authorization: Bearer ${INFISICAL_TOKEN}" \
  "https://app.infisical.com/api/v1/projects/54712f56-98a9-4531-9e97-0b588d2e5a88" \
  | jq '{id: .project.id, isLegacyAdditionalPrivilegesEnabled: .project.isLegacyAdditionalPrivilegesEnabled}'
```

(Exact response envelope field path may be `.project` per get-by-id OpenAPI; adjust jq if
the live payload nests differently — still read-only.)

## One-time Root steps still valid (B2 + GH only)

No dashboard. No secret values in chat. No Cursor Infisical/GitHub secret writes.
Do not run Terraform apply for Infisical secrets until a feasible approved grant path exists.

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

## After B2/GH (1–2) and a future approved Infisical grant

ACK → `deploy-terraform.yml` apply creates bucket, broker key, and Infisical secret
values automatically. Lifecycle track idle until ≥24h. No Codex key transfer into
CI/Cursor/prompts.

## Historical (do not run) — custom role packet

Superseded by the plan RBAC blocker. Official membership routes remain
[`GET`/`PATCH /api/v1/projects/{projectId}/memberships/identities/{identityId}`](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/get-by-id)
(not legacy `…/identity-memberships/{id}`). Do not retry role create.
