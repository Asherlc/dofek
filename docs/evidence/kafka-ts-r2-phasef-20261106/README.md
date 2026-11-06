# Sanitized evidence — `kafka-ts-r2-phasef-20261106`

Stock Apache Kafka **4.4.0** + Aiven RSM **v1.2.0** against **Cloudflare R2**
(`region=auto`, path-style, `AWS_*_CHECKSUM_*=WHEN_REQUIRED`) — **Phase F only**
(tiny functional Put/GetRange/consume).

Nonsecret artifacts only. No credentials, no payload bodies, no host env dumps,
no Compose overlays with secrets.

Narrative:
[`docs/kafka-tiered-storage-s3-compatibility.md`](../../kafka-tiered-storage-s3-compatibility.md).

## Scope (PASS bound)

| Item | Value |
|---|---|
| Verdict | **PHASE_F_PASS** |
| Produce | 64 × 1024 **value** bytes (= **65536**); producer input file **65600** bytes (= values + 64 newlines) — **not** a hard budget claim |
| Remote segment | offsets 0–63, `segmentSizeInBytes` **66417**; objects `.log` **66417** / `.indexes` **132** / `.rsm-manifest` **712** |
| Local before consume | closed segment removed; active `…00064.log` only |
| Digest | count 64; sha256(`offset\|value`) match |
| Client isolation | All Java admin/produce/consume in **384 MiB** client (heap **256 MiB**); never `docker exec` Java into broker (**2048 MiB** / heap **1 GiB**) |
| Config | stock `WHEN_REQUIRED` + path-style=`true`; **no** SDK/plugin patch |
| `observed_D` | **unknown** (no stock download meter); planning ~1 MiB was **not** a hard cap |
| MPU | **Not claimed** |
| RSM `DeleteObjects` / physical GC / DR / production | **Not proven** — cloud cleanup was **operator** parent S3 + CF DELETE |
| B2 / Phase M / Infisical / apply | **Not** in this run |

**Clarify:** simple Put/GetRange PASS does **not** prove MPU, disaster recovery,
or production readiness.

## Credential provision (this run)

| Route | Result |
|---|---|
| `GET /user/tokens/permission_groups` + Create Token | **Blocked** — HTTP **403** code **9109**; zero writes; **no** token broaden |
| Stock `POST …/r2/buckets` + `POST …/r2/temp-access-credentials` | **Succeeded** — disposable bucket; `object-read-write` prefix-scoped session TTL **3600**; `AWS_SESSION_TOKEN` via default chain |
| Custom JWT signer / paid setup | **Not used** |
| Parent in broker | **Forbidden / not used** |
| Session revoke API | **None** — TTL expiry; parent unchanged; bucket deleted |

## Operator cloud cleanup (verified)

See `ROOT_CLOUD_CLEANUP.json` (`at` **2026-11-06T23:08:00.602Z**,
`CLEANUP_VERIFIED`): ListObjects exact prefix **3** keys; **0** MPU; DeleteObjects
OK; bucket empty; CF DELETE bucket success; GET **404** code **10006**. Runtime
was **0** before cleanup. Manual cleanup — **not** plugin Delete/GC proof.
Do **not** recreate same bucket name before session expiry without review.

Official refs: [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/),
[temp-access-credentials API](https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/),
[Create Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/),
[Delete Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/).

## Compose teardown

`pnpm compose` wrapper, base file only, `down --remove-orphans --volumes` →
**0** owned containers / volumes (`docker-zero-confirm.txt`).

## Pins

| Artifact | Pin |
|---|---|
| Kafka | `apache/kafka:4.4.0` · `sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| Plugin | [Aiven v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0) |
| `core-1.2.0.tgz` | `sha256:14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` |
| `s3-1.2.0.tgz` | `sha256:1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010` |
| Endpoint | `https://<accountId>.r2.cloudflarestorage.com` · region `auto` · path-style |

## Files

- `CORE_PROOF.json` / `CORE_PROOF.sha256`
- `ROOT_CLOUD_CLEANUP.json`, `CLEANUP_REQUEST.json`, `ROOT_OWNERSHIP.json`, `ROOT_SETUP_RESULT.json` (IDs/TTL only)
- `hash-b.json`, `hash-plan.sha256`
- tier/local segment / copy log excerpts (sanitized)
- `plugin-provenance.json`, wall-clock stamps, `docker-zero-confirm.txt`

**Omitted on purpose:** produce/consume payload bodies; Compose/launch overlays;
plugin jars; any secret-bearing files.
