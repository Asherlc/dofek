# Readonly review — `e0f85bb07` runtime vs approved requirements

Reviewer: 87 (no edits to 3d paths). SHA
`e0f85bb077947d8a87ef28c36b7659c8a1d442a5`. CI for this SHA pending; obsolete
`886439efa` CI cancelled by Root.

## Requirement map (code present)

| Requirement | Where |
|---|---|
| Stock Kafka 4.4.0 + digest | `deploy/stack.yml:353`, `docker-compose.yml:123` |
| Aiven RSM 1.2.0 classpath | `deploy/stack.yml:372`, `docker-compose.yml:146` |
| Dedicated TS keys → AWS default chain (not `KAFKA_RSM_CONFIG_STORAGE_AWS_*`) | `scripts/deploy-service-environment.ts:23-29`, `:328-330`, `:482-486`; test quoting `:297-311` |
| No custom image/builder | stock `apache/kafka` + published `/plugins/1.2.0/{core,s3}` |
| Renderer fail-fast missing keys | `scripts/deploy-service-environment.ts:465-471` |
| Q13A `segment.bytes=33554432` / `segment.ms=3600000` / `local.retention.bytes=268435456` + B7 `retention.ms=604800000` / `retention.bytes=1073741824` | `.github/workflows/deploy-web-stack.yml:761-776`, verify `:785-791` |
| All new-cluster routes v2 + `.quarantine.v1` stock reconcile | `.github/workflows/deploy-web-stack.yml:804-829` + `assertWritableMetricStreamTopic` `:757` |
| appuser data write / plugins RO | `.github/workflows/deploy-web-stack.yml:521` (`chown 1000:1000` data), `:524` (`chmod a+rX` plugins); `deploy/stack.yml:388-390` (`:ro` plugins) |
| Preserve old RP bytes | `.github/workflows/deploy-web-stack.yml:516-517`; `deploy/stack.yml:387` |

## Actionable important findings (file:line only)

1. ~~`.github/workflows/deploy-web-stack.yml:785-791` — post-reconcile `grep` required list **omits** `cleanup.policy=delete`~~ — **fixed**: describe required list now includes `cleanup.policy=delete` (same create/alter set).

## Explicit non-findings (present / held elsewhere)

- Infisical `KAFKA_CLUSTER_ID` + `KAFKA_BROKERS` **resolved** (Root-provisioned; do not regenerate). Five `KAFKA_TIERED_STORAGE_*` + v2 topic cutover still pending — see `docs/kafka-infisical-bootstrap-keys.md`.
- Prod stack has no `KAFKA_RSM_CONFIG_STORAGE_S3_MULTIPART_UPLOAD_PART_SIZE` (`deploy/stack.yml:370-385`) — default Aiven **25 MiB**; with Q13A 32 MiB segments still size-eligible for MPU. Not a requirement miss for e0.
- No repeated cloud tests of this SHA from this review.

## Facts still unproven (cloud 20261107b)

| Fact | Status |
|---|---|
| Q-MPU (UploadPart / completed ETag `hash-N`) | **Unproven** — no retained ETag/ListObjects metadata; see `docs/evidence/kafka-ts-r2-q-mpudel-20261107b/A_MPU_ETAG_GAP.md` |
| RLMM `DELETE_SEGMENT_FINISHED` | **Unproven** — only `About to delete` + pre-op empty inventory |
| Consume order / content hash | **Unproven** — exit 0 + count 6060 only |
| Authoritative prior upload byte total / remaining Q11A budget | **Unknown** — cannot allocate A-only on “remaining” until Root attributes or grants fresh budget |
