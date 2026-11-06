# Sanitized evidence — `kafka-ts-b2-phasef-20261106`

Stock Apache Kafka **4.4.0** + Aiven RSM **v1.2.0** against **Backblaze B2**
(`us-west-004`) — **Phase F only** (tiny functional Put/GetRange/consume).

Nonsecret artifacts only. No credentials, no payload bodies, no host env dumps,
no operator launch scripts, no Compose overlays with secrets.

Narrative:
[`docs/kafka-tiered-storage-s3-compatibility.md`](../../kafka-tiered-storage-s3-compatibility.md).

## Scope (PASS bound)

| Item | Value |
|---|---|
| Verdict | **PHASE_F_PASS** |
| Produce | 64 × 1024 **value** bytes (= **65536**); producer input file **65600** bytes (= values + 64 newlines) — **not** a hard budget claim |
| Remote segment | offsets 0–63, `segmentSizeInBytes` **66417** |
| Local before consume | closed segment removed; active `…00064.log` only |
| Digest | count 64; sha256(`offset\|value`) match |
| Client isolation | All Java admin/produce/consume in **384 MiB** client (heap **256 MiB**); never `docker exec` Java into broker (**2048 MiB** / heap **1 GiB**) |
| `observed_D` | **unknown** (no stock download meter); planning ~1 MiB was **not** a hard cap |
| MPU | **Not claimed** |
| RSM `DeleteObjects` / physical GC | **Not proven** — cloud cleanup was **operator** B2 native API |
| R2 / Phase M / Infisical / apply | **Not** in this run |

## Operator cloud cleanup (verified)

See `ROOT_CLOUD_CLEANUP.json` (`at` **2026-11-06T22:22:53.342Z**,
`CLEANUP_VERIFIED`): child revoked; exactly 3 upload versions deleted
(66417 + 120 + 712); 0 markers; 0 unfinished MPU; bucket deleted; owned
buckets/keys 0.

Official B2 application-key delete note: v4-created keys require the v4 delete
path ([Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys);
[S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)).

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
| Endpoint | `https://s3.us-west-004.backblazeb2.com` |

## Files

- `CORE_PROOF.json` / `CORE_PROOF.sha256`
- `ROOT_CLOUD_CLEANUP.json`, `CLEANUP_REQUEST.json`, `ROOT_OWNERSHIP.json` (IDs only)
- `hash-b.json`, `hash-plan.sha256`
- tier/local segment / copy log excerpts (sanitized)
- `plugin-provenance.json`, wall-clock stamps, `docker-zero-confirm.txt`

**Omitted on purpose:** produce/consume payload bodies; Compose/launch overlays;
plugin jars; any secret-bearing files.
