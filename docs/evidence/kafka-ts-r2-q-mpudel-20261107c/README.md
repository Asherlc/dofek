# User budget request — `20261107c` A+B close (final packet; not executed)

**Status:** **Q14A approved.** Root may mint; Cursor executes **after Root STARTED**
(Cursor must **not** mint). Separate from unknown Q11A remaining. Infisical
`KAFKA_CLUSTER_ID` + `KAFKA_BROKERS` already provisioned (names-only; no further
bootstrap writes).

Closes gaps after strict `20261107b` (`02a5535a8`):
1. **A** — observed provider `.log` ETag `hash-N` with `N≥2` (not size eligibility).
2. **B** — RLMM stock-decoder latest `COPY_SEGMENT_FINISHED` history +
   `DELETE_SEGMENT_FINISHED`, then Root inventory **0** before cleanup.

**No C** consume/digest. Cite prior hashes below.

Frozen lab: `/tmp/kafka-ts-r2-q-mpudel-20261107c/` · repo
`docs/evidence/kafka-ts-r2-q-mpudel-20261107c/`. RLMM:
[`kafka-ts-rlmm-dump-procedure.md`](kafka-ts-rlmm-dump-procedure.md) @ `ea4a260b8+`.

## Exact identity

| Field | Value |
|---|---|
| Bucket | `kafka-ts-r2-q-mpudel-20261107c` |
| Prefix | `kafka-ts-parity/r2/20261107c-q-mpudel/` |
| Compose suffix | `kafka-ts-r2-q-mpudel-c` |
| Do **not** recreate | `…20261107`, `…20261107b` |

## Hard bounds (planned; not a network meter)

| Bound | Exact |
|---|---|
| Upload planned cap | **8 388 608** bytes |
| Credible planned total | **≤ 6 848 512** (≤ **6** remote objects after copy freeze) |
| Object body GET | **0** |
| Wall | **≤ 1200 s** after mint |
| Part size | **5 242 880** |
| Main closed `.log` | **5 500 000–6 291 456** (expect ETag `…-2`) |
| Quarantine | 64×1024 B values; object uppers below |

### Object upper bounds (initial copies only)

| Object | Upper |
|---|---|
| main `.log` / `.indexes` / `.rsm-manifest` | 6 291 456 / 262 144 / 65 536 |
| quarantine `.log` / `.indexes` / `.rsm-manifest` | 131 072 / 65 536 / 32 768 |
| **Sum (≤6 objects)** | **6 848 512** |
| Margin under 8 MiB | **1 540 096** |

**No custom upload-accounting framework.** Cap is a planned bound + operator stop,
not a hard byte meter on the wire.

### Stock freeze after ETag (Kafka 4.4)

After RSM copy success + Root Key/Size/ETag on main `.log`, set on **both** lab
topics (stock `kafka-configs.sh`):

`remote.storage.enable=true,remote.log.copy.disable=true,local.retention.ms=-2,local.retention.bytes=-2`

Official semantics
([Tiered Storage — Kafka 4.4](https://kafka.apache.org/44/operations/tiered-storage/),
[topic config `remote.log.copy.disable`](https://kafka.apache.org/44/configuration/topic-configs/)):
no further segment **uploads**; existing remote data stays readable; expiration
follows topic `retention.ms` / `retention.bytes` (so short retention for native
delete still applies). Docs require mapping `local.retention.*` to **`-2`** (or
equal to total retention) once copy is disabled — local retention otherwise
becomes irrelevant and can surprise disk use.

Then apply the short retention window for GC; do **not** keep producing into new
remote-eligible segments.

## Pass sequence (one packet)

1. **A:** After first main+quarantine copies, **before** retention — Root
   ListObjectsV2/HeadObject (Key+Size+ETag). Main `.log` ETag =
   Cloudflare completed-MPU [`hash-N`](https://developers.cloudflare.com/r2/objects/upload-objects/)
   with **N≥2** (expect `-2`); Size == local closed `.log`.
2. Stock **copy.disable** (+ `local.retention.*=-2`) as above.
3. Short retention → native remote delete (`About to delete` alone insufficient).
4. **RLMM** ([procedure](kafka-ts-rlmm-dump-procedure.md)): wrapper `ps -q kafka`
   → list `__remote_log_metadata-*` only → `stop kafka` (volume retained) →
   `docker cp` those dirs only → 384 MiB/heap256
   `--remote-log-metadata-decoder` (portable `read` loops) → latest `state=`
   needs `COPY_SEGMENT_FINISHED` history + `DELETE_SEGMENT_FINISHED` (or document
   gap).
5. Root inventory **0** + list-MPU **0** → cleanup / `down --volumes` / DELETE
   bucket.

## Explicit non-goals

- No consume/digest; no second cloud; no whole-datadir copy; no DIY meter/parser
- No MPU inference from size alone; no IAM/CI broaden; no Infisical bootstrap rewrite

## Prior consume hashes (cite only)

| Lab | Hash |
|---|---|
| R2 Phase F | `sha256_offset_pipe_value=a6818c55855297f2466d9d0967e2c97f6ebf6db61f7bd7c204d99bde6ecd5687` |
| Local dual512-fix | `sha256_offset_value=84647a6947925f3ec9977f7b36da31a962bfa096134281ada00f6c3d5a19370b` · `stdout_sha256=2d9df08fb5edb2f21780cd79665a930467eec59bbf0104999d51f83eecbcf2a6` |

## Pins

| Pin | Value |
|---|---|
| Kafka | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| `core-1.2.0.tgz` / `s3-1.2.0.tgz` | `14fb636d…` / `1fd89dea…` |
| Tool mem | 384 MiB |

## Approval

**Q14A** — approved. Frozen launch: `ROOT_LAUNCH_ARGV.json` +
`PRE_RETENTION_STOP_CHECKPOINT.json` under lab / `docs/evidence/kafka-ts-r2-q-mpudel-20261107c/`.
Root mint → STARTED → Cursor run. No second user ACK required.
