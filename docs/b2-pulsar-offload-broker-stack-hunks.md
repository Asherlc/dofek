# Future broker stack hunks (B2 offload)

**Do not apply to the dirty `deploy/stack.yml` until:** Infisical already has all five
`PULSAR_OFFLOAD_B2_*` secrets from Terraform apply, and Root reviews this hunk in
isolation. Keep this file as the integration surface — do not casually edit shared
dirty stack from the IaC lane.

R2 archive / erasure ledger / other R2 env remain unchanged.

When integrating, also export the same five keys from
`.github/templates/infisical-dotenv.tmpl` (not done here) so Swarm `env_file` rendering
receives them.

## Worker / shared env (near existing `PULSAR_OFFLOAD_R2_BUCKET`)

Replace offload bucket reference used for Pulsar BookKeeper sealed ledgers:

```yaml
# was: PULSAR_OFFLOAD_R2_BUCKET: ${PULSAR_OFFLOAD_R2_BUCKET:?…}
PULSAR_OFFLOAD_B2_BUCKET: ${PULSAR_OFFLOAD_B2_BUCKET:?PULSAR_OFFLOAD_B2_BUCKET is required}
```

(If worker still needs an R2 name for a different purpose, keep that R2 key separate —
do not overload.)

## `pulsar-broker` managedLedgerOffload* (stock aws-s3)

```yaml
PULSAR_PREFIX_managedLedgerOffloadBucket: ${PULSAR_OFFLOAD_B2_BUCKET:?PULSAR_OFFLOAD_B2_BUCKET is required}
PULSAR_PREFIX_managedLedgerOffloadServiceEndpoint: ${PULSAR_OFFLOAD_B2_ENDPOINT:?PULSAR_OFFLOAD_B2_ENDPOINT is required}
PULSAR_PREFIX_managedLedgerOffloadRegion: ${PULSAR_OFFLOAD_B2_REGION:?PULSAR_OFFLOAD_B2_REGION is required}
PULSAR_PREFIX_s3ManagedLedgerOffloadCredentialId: ${PULSAR_OFFLOAD_B2_KEY_ID:?PULSAR_OFFLOAD_B2_KEY_ID is required}
PULSAR_PREFIX_s3ManagedLedgerOffloadCredentialSecret: ${PULSAR_OFFLOAD_B2_APP_KEY:?PULSAR_OFFLOAD_B2_APP_KEY is required}
```

Expected Infisical values after TF apply:

| Key | Value |
| --- | --- |
| `PULSAR_OFFLOAD_B2_BUCKET` | `dofek-pulsar-offload` |
| `PULSAR_OFFLOAD_B2_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
| `PULSAR_OFFLOAD_B2_REGION` | `us-west-004` |
| `PULSAR_OFFLOAD_B2_KEY_ID` | broker application key id from TF |
| `PULSAR_OFFLOAD_B2_APP_KEY` | broker application key secret from TF |

Runtime key caps (TF): `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`, `readBuckets`.
`listAllBucketNames` omitted until Pulsar stock aws-s3 proves a ListBuckets need.
GetBucketLocation → `readBuckets` per Backblaze S3-compatible app-key docs; Pulsar
qualification still **UNQUALIFIED**.

**AWS credential mode:** these hunks set explicit
`s3ManagedLedgerOffloadCredentialId` / `Secret` from Infisical. That is **not** the
lab “AWS default chain with empty static id/secret” mode. Do not leave credential
env empty in production; do not print or log the key id/secret (compose config,
`docker service inspect`, CI echoes).
