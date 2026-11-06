# Pulsar offload B2 Terraform

Backblaze B2 holds Pulsar BookKeeper sealed-ledger offload objects. Cloudflare R2
continues to own the metric-stream archive and account-erasure ledger.

## Remaining steps (quantified)

| # | Owner | Action | Status |
| --- | --- | --- | --- |
| 0 | Cursor | TF providers + `deploy/b2-pulsar-offload.tf` + workflow OIDC-after-init | **done** (`0df983c1d`) |
| 1 | Cursor | Bootstrap script + packet + broker hunks doc | **done** (this tree) |
| 2 | **Root** | Review `--print-packet` (no writes) | **waiting** |
| 3 | **Root** | Run bootstrap with privately injected B2 management key + Infisical admin session | **waiting** |
| 4 | Root | ACK → `deploy-terraform.yml` apply (bucket + broker key + `PULSAR_OFFLOAD_B2_*`) | held |
| 5 | Cursor+Root | Separate `stack.yml` broker hunks after secrets exist | later |

Lifecycle observations: idle until ≥24h gate. No TF apply / Pulsar deploy from bootstrap alone.

## Auth contract

| Concern | Mechanism |
| --- | --- |
| HCP `dofek`/`dofek` | `execution_mode=local` |
| B2 TF provider | GH secrets `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` (dedicated IaC parent; never Codex mgmt key) |
| Infisical TF provider | GHA OIDC JWT minted **after** `terraform init` |
| Infisical IAM | Idempotent script [`scripts/bootstrap-b2-pulsar-offload-iac.ts`](../scripts/bootstrap-b2-pulsar-offload-iac.ts); CI stays `viewer` + narrow custom role |

Durable IAM definition = that script’s `buildInfisicalRoleMutationBody()` / `buildInfisicalMembershipPatchBody()`.
Re-run the script to reconcile. Not a dangling “later put role in TF” TODO (CI must not be project admin).

## Root packet

### Review only (no API writes)

```bash
cd /Users/asherlc/.paseo/worktrees/3b2webx6/pulsar-foundation
pnpm tsx scripts/bootstrap-b2-pulsar-offload-iac.ts --print-packet
```

### Execute (Root protected boundary)

Do **not** put secrets on argv (`gh --body`, CLI flags). Prefer silent read into env:

```bash
cd /Users/asherlc/.paseo/worktrees/3b2webx6/pulsar-foundation
# Codex-only management key — Root memory only; never paste into chat/Cursor:
read -rs B2_MANAGEMENT_KEY_ID; echo
read -rs B2_MANAGEMENT_KEY; echo
export B2_MANAGEMENT_KEY_ID B2_MANAGEMENT_KEY
# Infisical: already-logged CLI session, OR: read -rs INFISICAL_TOKEN; export INFISICAL_TOKEN
pnpm tsx scripts/bootstrap-b2-pulsar-offload-iac.ts
unset B2_MANAGEMENT_KEY_ID B2_MANAGEMENT_KEY INFISICAL_TOKEN
```

### Exact B2 IaC parent caps (account-scoped)

`listKeys`, `writeKeys`, `deleteKeys`, `listBuckets`, `readBuckets`, `writeBuckets`,
`deleteBuckets`, `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`  
Key name: `dofek-terraform-b2-iac` → stored via `gh secret set …` **stdin** into
`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`.

### Exact Infisical payloads (from primary create-role API `permissions` field)

Role slug `gha-pulsar-offload-b2-secrets`:

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

Membership PATCH for `46b66f72-0c77-4cfe-be1b-a43395e77be7` (`CI`):

```json
{ "roles": [{ "role": "viewer" }, { "role": "gha-pulsar-offload-b2-secrets" }] }
```

Read-only proof before bootstrap: CI membership is stock `viewer` only.

Broker stack consumption hunks (after apply): [b2-pulsar-offload-broker-stack-hunks.md](./b2-pulsar-offload-broker-stack-hunks.md).
