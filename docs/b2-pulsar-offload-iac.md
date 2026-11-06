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

## One-time Root steps (stock primitives only — review before run)

No dashboard. No key paste into chat. Secrets stay in Root private process env / stdin.
Do not run until Root ACK of scopes below. No Terraform apply in this section.

Constants: project `54712f56-98a9-4531-9e97-0b588d2e5a88`, CI identity
`46b66f72-0c77-4cfe-be1b-a43395e77be7`, key name `dofek-terraform-b2-iac`, role slug
`gha-pulsar-offload-b2-secrets`.

### 1. B2 — create dedicated IaC parent key

Capabilities (7): `listBuckets`, `readBuckets`, `writeBuckets`, `deleteBuckets`,
`listKeys`, `writeKeys`, `deleteKeys`. (`writeKeys` is account-wide.)

If `b2_list_keys` already shows name `dofek-terraform-b2-iac`, **stop** (no delete/rotate).

Authorize (management key only in Root env):

```http
GET https://api.backblazeb2.com/b2api/v3/b2_authorize_account
Authorization: Basic base64(keyId:key)
```

Create ([b2_create_key v4](https://www.backblaze.com/apidocs/b2-create-key)):

```http
POST {apiUrl}/b2api/v4/b2_create_key
Authorization: {authorizationToken}
Content-Type: application/json
```

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

### 2. GitHub Actions secrets (stdin — never `--body`, never print values)

```bash
gh secret set B2_APPLICATION_KEY_ID   # paste applicationKeyId on stdin, EOF
gh secret set B2_APPLICATION_KEY      # paste applicationKey on stdin, EOF
```

### 3. Infisical — narrow role (once)

[Create project role](https://infisical.com/docs/api-reference/endpoints/project-roles/create)
`POST https://app.infisical.com/api/v1/projects/54712f56-98a9-4531-9e97-0b588d2e5a88/roles`

```json
{
  "slug": "gha-pulsar-offload-b2-secrets",
  "name": "GHA Pulsar offload B2 secrets",
  "permissions": [
    {
      "subject": "secrets",
      "action": ["describeSecret", "readValue", "create", "edit"],
      "conditions": {
        "environment": { "$eq": "prod" },
        "secretPath": { "$eq": "/" },
        "secretName": { "$glob": "PULSAR_OFFLOAD_B2_*" }
      }
    }
  ]
}
```

Skip create if slug already exists.

### 4. Infisical — attach role; preserve every existing membership role

`GET …/identity-memberships/46b66f72-0c77-4cfe-be1b-a43395e77be7` → collect current
`customRoleSlug || role` values → `PATCH` same path with **all** of them plus
`gha-pulsar-offload-b2-secrets` if missing ([update membership](https://infisical.com/docs/api-reference/endpoints/project-identities-membership/update-identity-membership)):

```json
{
  "roles": [
    { "role": "viewer" },
    { "role": "gha-pulsar-offload-b2-secrets" }
  ]
}
```

(Example assumes today’s membership is only `viewer`. If GET returns more roles, include
every one — do not replace with only viewer+new.)

## After Root completes 1–4 (held)

ACK → `deploy-terraform.yml` apply creates bucket, broker key, and Infisical secret
values automatically. Lifecycle track idle until ≥24h. No Codex key transfer into
CI/Cursor/prompts.
