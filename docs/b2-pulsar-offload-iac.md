# Pulsar offload B2 Terraform

Backblaze B2 holds Pulsar BookKeeper sealed-ledger offload objects. Cloudflare R2
continues to own the metric-stream archive and account-erasure ledger.

## Auth contract

| Concern | Mechanism | Source |
| --- | --- | --- |
| HCP Terraform workspace `dofek`/`dofek` | `execution_mode=local` (plan/apply on GHA runner; state in HCP) | HCP workspace attributes API |
| B2 provider | Env `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` on the runner | [Backblaze/b2 0.14.1](https://registry.terraform.io/providers/Backblaze/b2/0.14.1/docs) |
| Infisical provider | GitHub OIDC: `INFISICAL_AUTH_METHOD=oidc`, `INFISICAL_MACHINE_IDENTITY_ID`, `INFISICAL_AUTH_JWT` minted **after** `terraform init`, immediately before `apply` | [Infisical provider](https://registry.terraform.io/providers/infisical/infisical/0.20.12/docs), [GitHub OIDC](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github) |
| Runtime secrets | `infisical_secret` resources write `PULSAR_OFFLOAD_B2_*` at `/` (existing dotenv export) | [`.github/templates/infisical-dotenv.tmpl`](../.github/templates/infisical-dotenv.tmpl) |
| Secrets in state | Broker app key stays in encrypted HCP state; no sensitive TF outputs; JWT masked in GHA | — |

Identity used by deploy Terraform: `46b66f72-0c77-4cfe-be1b-a43395e77be7` (`CI`), same default as
[`load-infisical-secrets`](../.github/actions/load-infisical-secrets/action.yml).

## Resources (TF)

- Private bucket `dofek-pulsar-offload` (`prevent_destroy`)
- Lifecycle: hide→delete 1d, unfinished MPU cancel 1d; no upload→hide; no Object Lock
- Bucket-scoped broker key capabilities: `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`, `readBuckets`
- Infisical keys: `PULSAR_OFFLOAD_B2_BUCKET`, `PULSAR_OFFLOAD_B2_ENDPOINT`, `PULSAR_OFFLOAD_B2_REGION`, `PULSAR_OFFLOAD_B2_KEY_ID`, `PULSAR_OFFLOAD_B2_APP_KEY`

Broker stack wiring to those env names is a **separate** review once apply has created the secrets.

## Bootstrap (API only — no dashboard / key paste)

Blocked until an authorized operator runs these. Codex may create the **new** B2 IaC parent key
via API; the existing Codex management key is never copied into CI, Infisical, or agent prompts.

### 1. Dedicated B2 IaC parent key → GitHub Actions secrets

Create a **new** application key (account-scoped, not bucket-restricted) with capabilities needed
to manage buckets and child keys (not the runtime broker key):

- `listBuckets`, `readBuckets`, `writeBuckets`, `deleteBuckets`
- `listKeys`, `writeKeys`, `deleteKeys`
- `listFiles`, `readFiles`, `writeFiles`, `deleteFiles` (lifecycle / object admin as required by provider)
- `readBucketLifecycleRules`, `writeBucketLifecycleRules` when using S3-compatible lifecycle APIs

Native create: [b2_create_key](https://www.backblaze.com/apidocs/b2-create-key). Store **only** in
repository secrets `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY` (GHA API / `gh secret set` with
value on stdin). Never reuse or transfer the Codex management key.

### 2. Infisical scoped write for `CI` (not whole `/`)

Read-only proof (2026-11-06): `GET /api/v1/projects/54712f56-98a9-4531-9e97-0b588d2e5a88/identity-memberships`
shows identity `46b66f72-…` name `CI` with stock role `viewer` only.

`CI` cannot create project roles or rewrite memberships while it is viewer-only. Bootstrap
(admin/user API, reviewed) must add a **custom role** limited to `PULSAR_OFFLOAD_B2_*` before
Terraform can write secrets. Prefer `secretName` `$glob` over granting all of `/`:

```http
POST /api/v1/projects/54712f56-98a9-4531-9e97-0b588d2e5a88/roles
```

Body (permissions_v2 shape per
[project permissions](https://infisical.com/docs/internals/permissions/project-permissions)):

- slug: `gha-pulsar-offload-b2-secrets`
- secrets actions: `describeSecret`, `readValue`, `create`, `edit`
- conditions: `environment.$eq=prod`, `secretPath.$eq=/`, `secretName.$glob=PULSAR_OFFLOAD_B2_*`

Then attach that role **alongside** `viewer` on the `CI` identity membership (do not drop
viewer). Keep secrets at `/` so the existing dotenv template continues to export them without a
second folder.

### 3. Terraform reconcile (ongoing)

After GH secrets + scoped Infisical write exist, `deploy-terraform.yml` creates/updates the B2
bucket, broker key, and Infisical secret values. No manual key paste from TF output.

Optional follow-up (elevated Infisical identity required): import
`infisical_project_role` + `infisical_project_identity` (`adopt_existing`) so Terraform owns the
custom role definition. Until that identity exists, re-run the bootstrap role API to reconcile
IAM; do not leave a production-code TODO for dashboard clicks.
