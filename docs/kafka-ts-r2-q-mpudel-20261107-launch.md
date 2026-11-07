# Root launch packet — R2 Q-MPU+Q-DEL (`20261107`) — readonly

**Docs only.** No allocate / mint / List / mutate until **user** cloud-budget
ACK on [`kafka-ts-r2-qualification-manifest.md`](kafka-ts-r2-qualification-manifest.md).

Mirrors Phase F ops shape
(`/tmp/kafka-ts-r2-phasef-20261106/ROOT_OPS_PACKET.md`) with corrected identity
and `storage.s3` env keys.

## Exact identity

- Account: `8e5b2f62ffe8ebdd48e725d325a6d51e`
- Bucket: `kafka-ts-r2-q-mpudel-20261107`
- Prefix: `kafka-ts-parity/r2/20261107-q-mpudel/`
- TTL: `3600`
- Wall after mint: **≤ 55 min**
- Total upload bound: **≤ 16 MiB** (both topics + metadata + part bodies)

## Credentials (Root-only; names)

```text
CF_API_TOKEN          # Bearer = Infisical CLOUDFLARE_API_TOKEN class (Workers R2 Storage Write for create+mint)
R2_ACCESS_KEY_ID      # parentAccessKeyId only (archive key ID); secret Root-only for mint/cleanup
```

Broker child only after mint: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN`. Never parent/Bearer in broker.

## Create + mint (after user budget ACK only)

```bash
# Create
curl -sS -X POST   "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets"   -H "Authorization: Bearer ${CF_API_TOKEN}"   -H "Content-Type: application/json"   -d '{"name":"kafka-ts-r2-q-mpudel-20261107"}'

# Mint
curl -sS -X POST   "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/temp-access-credentials"   -H "Authorization: Bearer ${CF_API_TOKEN}"   -H "Content-Type: application/json"   -d '{
    "bucket": "kafka-ts-r2-q-mpudel-20261107",
    "parentAccessKeyId": "'"${R2_ACCESS_KEY_ID}"'",
    "permission": "object-read-write",
    "ttlSeconds": 3600,
    "prefixes": ["kafka-ts-parity/r2/20261107-q-mpudel/"]
  }'
```

Return to Cursor: bucket, prefix, TTL expiry, child **accessKeyId only** (no
secrets).

## Broker env keys (must include STORAGE)

```text
KAFKA_RSM_CONFIG_STORAGE_BACKEND_CLASS=io.aiven.kafka.tieredstorage.storage.s3.S3Storage
KAFKA_RSM_CONFIG_STORAGE_S3_BUCKET_NAME=kafka-ts-r2-q-mpudel-20261107
KAFKA_RSM_CONFIG_STORAGE_S3_ENDPOINT_URL=https://${ACCOUNT_ID}.r2.cloudflarestorage.com
KAFKA_RSM_CONFIG_STORAGE_S3_REGION=auto
KAFKA_RSM_CONFIG_STORAGE_S3_PATH_STYLE_ACCESS_ENABLED=true
KAFKA_RSM_CONFIG_STORAGE_S3_MULTIPART_UPLOAD_PART_SIZE=5242880
KAFKA_RSM_CONFIG_KEY_PREFIX=kafka-ts-parity/r2/20261107-q-mpudel/
AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
```

Do **not** set `KAFKA_RSM_CONFIG_S3_*` (missing `STORAGE`) — ignored for part size.

## Cleanup

Stop compose → ListObjectsV2 / list-MPU under prefix → DeleteObjects / abort
**quiesced** MPUs only → DELETE bucket → GET 404. No parent revoke API.
