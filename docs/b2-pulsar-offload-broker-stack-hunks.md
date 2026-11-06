# Future broker stack hunks (B2 offload)

**Do not apply to the dirty `deploy/stack.yml` until:** Infisical already has the B2
runtime secrets from Terraform apply, and Root reviews this hunk in isolation. Keep
this file as the integration surface — do not casually edit shared dirty stack from
the IaC lane. **No dirty-stack integration / TF apply / Infisical access grant** until
those respective approvals.

R2 archive / erasure ledger / other R2 env remain unchanged.

When integrating, export the needed keys from `.github/templates/infisical-dotenv.tmpl`
(not done here) so Swarm `env_file` rendering receives them.

## Why the first draft used explicit `PULSAR_PREFIX_…CredentialId/Secret`

That draft mirrored the **uncommitted Pulsar draft** in dirty `deploy/stack.yml`
(`managedLedgerOffloadDriver: S3` + PREFIX credential id/secret from
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`). Continuity with that draft file was the
only reason — **not** a B2, Backblaze, or stock `aws-s3` requirement.

**Label carefully:** Pulsar is **not** currently running in production. That
`stack.yml` R2 offload block is an **uncommitted / not-yet-deployed draft**, not an
observed production credential-exposure finding. Do not describe it as live prod R2
Pulsar config.

## Upstream startup chain (draft stack entrypoint)

The draft broker service uses:

```text
entrypoint → bin/apply-config-from-env.py conf/broker.conf && exec bin/pulsar broker
```

`apply-config-from-env.py` materializes `PULSAR_PREFIX_*` (and matching conf keys) into
`conf/broker.conf` on disk. Therefore non-empty PREFIX
`s3ManagedLedgerOffloadCredentialId` / `CredentialSecret` would be **written into
broker.conf** if that draft were ever deployed as written. A docs line saying “do not
echo” does not prevent that apply-config write. Lab overlay silenced apply-config
stdout (`>/dev/null`) for the same reason.

## Root-approved stock path (lab `b2-stock-oxia-1` + this proposal)

Root approved stock AWS default credential chain for these **proposed** B2 hunks:
empty static PREFIX credentials; `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from
dedicated Infisical B2 keys. Aligns proven lab strategy; no extra machinery.

Driver `aws-s3` (not the jclouds `S3` string in the dirty R2 draft). Empty static PREFIX
credentials; AWS default chain supplies keys ([Pulsar 5.0 tiered storage —
Authentication with AWS](https://pulsar.apache.org/docs/5.0.x/cookbooks-tiered-storage/)):

```yaml
managedLedgerOffloadDriver: aws-s3
PULSAR_PREFIX_s3ManagedLedgerOffloadCredentialId: ""
PULSAR_PREFIX_s3ManagedLedgerOffloadCredentialSecret: ""
# Bucket/endpoint/region via s3ManagedLedgerOffload* (non-secret)
# Credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in process env
# (Infisical PULSAR_OFFLOAD_B2_KEY_ID / APP_KEY) — not PREFIX.
```

**Requirements do not force PREFIX credentials** for durable B2 offload.

## Approved proposed hunks (stock aws-s3 + AWS default chain)

### Worker / shared env (near existing draft `PULSAR_OFFLOAD_R2_BUCKET`)

Keep R2 keys for any non-BK purpose. For BK sealed-ledger offload bucket name:

```yaml
PULSAR_OFFLOAD_B2_BUCKET: ${PULSAR_OFFLOAD_B2_BUCKET:?PULSAR_OFFLOAD_B2_BUCKET is required}
```

### `pulsar-broker` (replace draft R2 offload PREFIX block for BK sealed ledgers)

```yaml
managedLedgerOffloadDriver: aws-s3
PULSAR_PREFIX_s3ManagedLedgerOffloadBucket: ${PULSAR_OFFLOAD_B2_BUCKET:?PULSAR_OFFLOAD_B2_BUCKET is required}
PULSAR_PREFIX_s3ManagedLedgerOffloadServiceEndpoint: ${PULSAR_OFFLOAD_B2_ENDPOINT:?PULSAR_OFFLOAD_B2_ENDPOINT is required}
PULSAR_PREFIX_s3ManagedLedgerOffloadRegion: ${PULSAR_OFFLOAD_B2_REGION:?PULSAR_OFFLOAD_B2_REGION is required}
PULSAR_PREFIX_s3ManagedLedgerOffloadMaxBlockSizeInBytes: "67108864"
# Empty static → AWS default chain (do not put key material in PREFIX)
PULSAR_PREFIX_s3ManagedLedgerOffloadCredentialId: ""
PULSAR_PREFIX_s3ManagedLedgerOffloadCredentialSecret: ""
AWS_ACCESS_KEY_ID: ${PULSAR_OFFLOAD_B2_KEY_ID:?PULSAR_OFFLOAD_B2_KEY_ID is required}
AWS_SECRET_ACCESS_KEY: ${PULSAR_OFFLOAD_B2_APP_KEY:?PULSAR_OFFLOAD_B2_APP_KEY is required}
```

Command (match lab — avoid apply-config stdout leaking conf dumps):

```yaml
command:
  - bin/apply-config-from-env.py conf/broker.conf >/dev/null && exec bin/pulsar broker
```

Drop inherited draft R2-only knobs when cutting over (`jclouds.s3.signer-version`,
`managedLedgerOffload*` non-`s3` bucket PREFIX keys, R2 credential PREFIX) the same way
the lab overlay reset MinIO inheritances.

Expected Infisical → env mapping after TF apply:

| Infisical / env | Role |
| --- | --- |
| `PULSAR_OFFLOAD_B2_BUCKET` | bucket (PREFIX / non-secret) |
| `PULSAR_OFFLOAD_B2_ENDPOINT` | endpoint (PREFIX / non-secret) |
| `PULSAR_OFFLOAD_B2_REGION` | region (PREFIX / non-secret) |
| `PULSAR_OFFLOAD_B2_KEY_ID` | → `AWS_ACCESS_KEY_ID` only |
| `PULSAR_OFFLOAD_B2_APP_KEY` | → `AWS_SECRET_ACCESS_KEY` only |

Runtime key caps (TF broker key): `listFiles`, `readFiles`, `writeFiles`,
`deleteFiles`, `readBuckets`. `listAllBucketNames` omitted until stock `aws-s3` proves
ListBuckets need. Qualification still **UNQUALIFIED** (actual absence of attributed
objects — not the clock).

**Do not** set non-empty `PULSAR_PREFIX_s3ManagedLedgerOffloadCredentialId/Secret` for
B2: that would force secrets into `broker.conf` via apply-config. Keep secrets on the
AWS env default-chain path only.
