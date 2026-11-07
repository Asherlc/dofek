# User budget request — `20261107c` A+B close (not executed)

**Status:** request only. **No mint / allocation / cloud** until the user
approves this **new** budget (separate from exhausted/unknown Q11A remaining).

Closes the two gaps left after strict `02a5535a8` / `20261107b`:
1. **A** — observed provider `.log` ETag `hash-N` with `N≥2` (not size eligibility).
2. **B** — RLMM/stock-decoder `COPY_SEGMENT_FINISHED` + `DELETE_SEGMENT_FINISHED`,
   then Root inventory **0** before cleanup.

**No C** consume/digest rerun. Cite prior hashes separately (below).

Frozen credential-free lab (local): `/tmp/kafka-ts-r2-q-mpudel-20261107c/`
(`BUDGETS.json`, `NAMES.json`, `plugin-provenance.json`, `FILE_HASHES.sha256`,
compose base). Repo mirror after commit:
`docs/evidence/kafka-ts-r2-q-mpudel-20261107c/`.

## Exact identity

| Field | Value |
|---|---|
| Bucket nonce | `kafka-ts-r2-q-mpudel-20261107c` |
| Prefix | `kafka-ts-parity/r2/20261107c-q-mpudel/` |
| Compose suffix | `kafka-ts-r2-q-mpudel-c` |
| Do **not** recreate | `…20261107`, `…20261107b` |

## Hard bounds

| Bound | Exact |
|---|---|
| Upload cap | **8 388 608** bytes (8 MiB) total planned remote objects |
| Object body GET | **0** |
| Wall | **≤ 1200 s** after mint |
| Part size | **5 242 880** |
| Main closed `.log` | **5 500 000–6 291 456** bytes (strictly &gt; part size → expect **2** parts / ETag `…-2`) |
| Tiny quarantine | 64×1024 B values; remote object uppers below |

### Planned object upper bounds (bytes)

| Object | Upper |
|---|---|
| main `.log` | 6 291 456 |
| main `.indexes` | 262 144 |
| main `.rsm-manifest` | 65 536 |
| quarantine `.log` | 131 072 |
| quarantine `.indexes` | 65 536 |
| quarantine `.rsm-manifest` | 32 768 |
| **Sum** | **6 848 512** |
| Margin under 8 MiB | **1 540 096** |

Produce **input** uppers (not the upload meter): main value bytes ≤ 6 291 456;
quarantine producer file ≤ 65 600. Upload accounting uses the object table only.

## Pass criteria

**A (MPU):** After RSM copy success, **before** retention — Root
`ListObjectsV2` / `HeadObject` (Key + Size + ETag only). Main `.log` ETag matches
Cloudflare completed-MPU form [`hash-` + partCount](https://developers.cloudflare.com/r2/objects/upload-objects/)
with **N≥2** (expect `-2`); Size equals local closed `.log`. No body GET.

**B (delete + RLMM):** One capture sequence on **this** packet only (do **not**
recreate `20261107` / `20261107b`; no second cloud for metadata). Stock procedure:
[`docs/kafka-ts-rlmm-dump-procedure.md`](kafka-ts-rlmm-dump-procedure.md).

1. Native retention delete window (RSM `About to delete` alone is **insufficient**).
2. Wrapper `ps -q kafka` → shell-list **only** `__remote_log_metadata-*` dirs →
   wrapper `stop kafka` (**volume retained**) → `docker cp` those metadata dirs
   only into `$LAB/evidence/rlmm-logs/` (never whole `/var/lib/kafka/data`; no
   raw `docker compose`). Full steps:
   [`docs/kafka-ts-rlmm-dump-procedure.md`](../../kafka-ts-rlmm-dump-procedure.md).
3. Separate tool container: **384 MiB** cgroup / `KAFKA_HEAP_OPTS=-Xms32m -Xmx256m`,
   readonly mount → `kafka-dump-log.sh --remote-log-metadata-decoder --files …`
   per `.log` (decoder auto-enables print-data-log; no maintained parser;
   portable `read` loops, not `mapfile`).
4. Inspect stock stdout in log order: latest `state=` per segment id — need
   `COPY_SEGMENT_FINISHED` in history + latest `DELETE_SEGMENT_FINISHED` (or
   document unfinished gap; do not overclaim).
5. Then Root inventory **0** objects + **0** MPU under prefix **before** operator
   cleanup; DELETE bucket / wrapper `down --volumes`.

## Explicit non-goals

- No consume / no digest / no order-hash rerun (C already partial on 20261107b)
- No MPU inference from size or “remaining” Q11A budget
- No parent revoke; no CI/IAM broaden

## Prior consume hashes (cite only — do not rerun)

| Lab | Hash |
|---|---|
| R2 Phase F | `docs/evidence/kafka-ts-r2-phasef-20261106/CORE_PROOF.json` → `sha256_offset_pipe_value=a6818c55855297f2466d9d0967e2c97f6ebf6db61f7bd7c204d99bde6ecd5687` |
| Local dual512-fix | `docs/evidence/kafka-ts-dual512-fix-20261106/CORE_PROOF.json` → `sha256_offset_value=84647a6947925f3ec9977f7b36da31a962bfa096134281ada00f6c3d5a19370b`, `stdout_sha256=2d9df08fb5edb2f21780cd79665a930467eec59bbf0104999d51f83eecbcf2a6` |

## Credential-free pins

| Pin | Value |
|---|---|
| Kafka | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| `core-1.2.0.tgz` | `sha256:14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` |
| `s3-1.2.0.tgz` | `sha256:1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010` |
| Client tool mem | 384 MiB (no broker JVM for uuid / CLI) |
| File hashes | `/tmp/…20261107c/FILE_HASHES.sha256` |

## Approval asked

Approve **one** disposable R2 run under the bounds above (8 MiB upload / 0 body
GET / ≤20 min / bucket `…20261107c`), Root metadata-before-retention + native
delete/RLMM capture, then cleanup. **No allocation until answered.**
