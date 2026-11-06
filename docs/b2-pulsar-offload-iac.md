# Pulsar offload B2 Terraform

Backblaze B2 holds Pulsar BookKeeper sealed-ledger offload objects. Cloudflare R2
continues to own the metric-stream archive and account-erasure ledger.

## Auth contract

| Concern | Mechanism | Source |
| --- | --- | --- |
| HCP Terraform workspace `dofek`/`dofek` | `execution_mode=local` (plan/apply on GHA runner; state in HCP) | HCP workspace attributes API |
| B2 provider | Env `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` on the runner (dedicated IaC parent key) | [Backblaze/b2 0.14.1](https://registry.terraform.io/providers/Backblaze/b2/0.14.1/docs) |
| Infisical provider | GitHub OIDC: JWT minted **after** `terraform init`, immediately before `apply` | [Infisical provider](https://registry.terraform.io/providers/infisical/infisical/0.20.12/docs), [GitHub OIDC](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github) |
| Runtime secrets | `infisical_secret` → `PULSAR_OFFLOAD_B2_*` at `/` | [dotenv template](../.github/templates/infisical-dotenv.tmpl) |
| Infisical IAM (scoped write) | Versioned bootstrap script (idempotent API); CI stays `viewer` + custom role, never project admin | [`scripts/bootstrap-b2-pulsar-offload-iac.ts`](../scripts/bootstrap-b2-pulsar-offload-iac.ts) |

Identity: `46b66f72-0c77-4cfe-be1b-a43395e77be7` (`CI`).

Why IAM is not in the CI Terraform apply: `CI` is stock `viewer` and must not gain
broad project-admin. Role create/membership patch requires elevated Infisical auth.
That one-time **authentication** exception is Root injecting credentials into the
bootstrap script; the script performs all resource API calls (no dashboard). Re-run
the same script to reconcile the role definition — not a dangling “later TF” TODO.

## Resources (TF)

- Private bucket `dofek-pulsar-offload` (`prevent_destroy`)
- Lifecycle: hide→delete 1d, unfinished MPU cancel 1d; no upload→hide; no Object Lock
- Bucket-scoped broker key: `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`, `readBuckets`
- Infisical: `PULSAR_OFFLOAD_B2_BUCKET|ENDPOINT|REGION|KEY_ID|APP_KEY`

Broker stack wiring: [b2-pulsar-offload-broker-stack-hunks.md](./b2-pulsar-offload-broker-stack-hunks.md)
(separate commit after secrets exist).

## Root bootstrap packet (protected boundary)

**Cursor never receives the Codex management key.** Root injects it privately and runs:

```bash
cd /Users/asherlc/.paseo/worktrees/3b2webx6/pulsar-foundation
# Private injection only — do not echo / log / paste into chat:
#   B2_MANAGEMENT_KEY_ID  = existing Codex-only management applicationKeyId
#   B2_MANAGEMENT_KEY     = existing Codex-only management applicationKey
# Infisical: use logged-in CLI session, or INFISICAL_TOKEN=<user/admin access token>
B2_MANAGEMENT_KEY_ID='…' B2_MANAGEMENT_KEY='…' \
  pnpm tsx scripts/bootstrap-b2-pulsar-offload-iac.ts
```

### What the script does (audited)

| Step | API / CLI | Scopes | Non-secret output |
| --- | --- | --- | --- |
| 1 | `b2_authorize_account` | management key | accountId (not printed as secret) |
| 2 | `b2_list_keys` | `listKeys` | whether `dofek-terraform-b2-iac` exists |
| 3 | `b2_create_key` (v4) or reuse | `writeKeys`; caps = list/read/write/delete Keys+Buckets+Files | `applicationKeyId` only |
| 4 | `gh secret set B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` | repo Actions secrets | secret **names** confirmed via `gh secret list` |
| 5 | Infisical `POST|PATCH …/roles` | project role admin | slug `gha-pulsar-offload-b2-secrets` |
| 6 | Infisical `PATCH …/identity-memberships/{CI}` | membership admin | roles `viewer` + custom slug |

If the named B2 IaC key exists but GH secrets are missing: re-run with
`FORCE_ROTATE_B2_IAC_KEY=1` (deletes that named key and recreates). Never recover a
lost applicationKey from list APIs.

### After bootstrap succeeds (still no apply until ACK)

1. Confirm GH secret **names** `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY` exist.
2. Confirm Infisical membership for `CI` includes `gha-pulsar-offload-b2-secrets`.
3. Root ACK → `deploy-terraform.yml` apply creates bucket + broker key + Infisical secrets.
4. Separate stack hunk commit per broker-stack-hunks doc.

No production Terraform apply or Pulsar deploy from this packet alone.
