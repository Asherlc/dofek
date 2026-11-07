# Root launch packet — R2 Q-MPU+Q-DEL (`20261107`)

**Execute only after user Q11A** (granted). Companion:
[`kafka-ts-r2-qualification-manifest.md`](kafka-ts-r2-qualification-manifest.md).

Frozen lab (credential-free): `/tmp/kafka-ts-r2-q-mpudel-20261107/` — standalone;
does **not** require Phase F `/tmp` paths.

## Exact identity

- Account: `8e5b2f62ffe8ebdd48e725d325a6d51e`
- Bucket: `kafka-ts-r2-q-mpudel-20261107`
- Prefix: `kafka-ts-parity/r2/20261107-q-mpudel/`
- TTL: `3600`
- Wall after mint: **≤ 55 min**
- Total upload bound: **≤ 16 MiB**
- Read planning: ~10 MiB (**not** a hard cap); `observed_D` unknown

## Credentials (Root private memory only)

```text
CF_API_TOKEN          # Bearer = CLOUDFLARE_API_TOKEN class (Workers R2 Storage Write)
R2_ACCESS_KEY_ID      # parentAccessKeyId only; secret Root-only for mint/cleanup
```

Broker child only: `KAFKA_TS_R2_CHILD_*` → `AWS_*` via placeholder overlay.
**Parent never in broker.** No retained secret files / dotenv.

### Mint hygiene (mandatory)

Capture create/mint JSON into a **private operator process variable** (or
memory-only tool). **Do not** print `secretAccessKey` / `sessionToken` /
`Authorization` headers to terminal logs, chat, or evidence. Return to Cursor
**names-only**: bucket, prefix, TTL expiry, child `accessKeyId`.

There is **no stock child temp-credential revoke API**. Parent R2 key
revocation **exists** but is **forbidden** for this lab (would hit the unrelated
prod archive parent). Cleanup = stop broker → delete objects/MPUs under prefix →
DELETE bucket → TTL expiry of child session.

## Official API shape (standalone)

```bash
# Create (names only in logs)
curl -sS -X POST   "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets"   -H "Authorization: Bearer ${CF_API_TOKEN}"   -H "Content-Type: application/json"   -d '{"name":"kafka-ts-r2-q-mpudel-20261107"}'   -o /dev/null -w '%{http_code}\n'

# Mint — capture body privately; never tee secrets
# MINT_JSON="$(curl -sS -X POST .../temp-access-credentials ...)"
# Then map fields in-memory to KAFKA_TS_R2_CHILD_* for compose up only.
```

Official:
[temp credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/),
[create](https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/),
[Create Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/).

## Broker env keys (`STORAGE` required)

See frozen `docker-compose.yml` — `KAFKA_RSM_CONFIG_STORAGE_S3_*` including
`MULTIPART_UPLOAD_PART_SIZE=5242880`. Wrong `KAFKA_RSM_CONFIG_S3_*` (no
`STORAGE`) is ignored.

## Launch argv

Authoritative: `/tmp/kafka-ts-r2-q-mpudel-20261107/ROOT_LAUNCH_ARGV.json`.
