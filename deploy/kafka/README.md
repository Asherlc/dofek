# Stock Kafka (runtime)

Official [`apache/kafka:4.4.0`](https://hub.docker.com/r/apache/kafka) + released
[Aiven tiered-storage-for-apache-kafka v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0).
No custom broker image.

Design authority: [`docs/kafka-tiered-storage-assessment.md`](../../docs/kafka-tiered-storage-assessment.md).
IaC contract (bucket/token/Infisical): [`docs/kafka-ts-r2-offload-iac.md`](../../docs/kafka-ts-r2-offload-iac.md).

**Not merge/deploy ready** until five `KAFKA_TIERED_STORAGE_*` keys (TF apply)
and v2 topic cutover (drained) are done. `KAFKA_CLUSTER_ID` + `KAFKA_BROKERS`
are **resolved** (Root-provisioned; see
[`docs/kafka-infisical-bootstrap-keys.md`](../../docs/kafka-infisical-bootstrap-keys.md));
do **not** regenerate the cluster id. `METRIC_STREAM_*` topic values unchanged
by that bootstrap. RSM is the steady production configuration (enabled);
there is no TS-off stopgap in stack.

## Pins

| Artifact | Pin |
|---|---|
| Broker image | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| `core-1.2.0.tgz` | `sha256:14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` |
| `s3-1.2.0.tgz` | `sha256:1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010` |

## Host plugin layout (immutable version pair)

```text
/mnt/dofek-data/kafka/plugins/1.2.0/core/   # jars from core-1.2.0.tgz
/mnt/dofek-data/kafka/plugins/1.2.0/s3/     # jars from s3-1.2.0.tgz
/mnt/dofek-data/kafka/data/                # new Kafka data dir — never reuse Redpanda
```

Classpath: `/plugins/1.2.0/core/*:/plugins/1.2.0/s3/*` (matches published layout).
Publish: stock curl + sha256 + exact roots + `mv` of version pair **if absent**
(deploy-web-stack step). Never `rm -rf` a version in use.

## Infisical → kafka.env (fail-closed rename only)

Lane 87 mints dedicated R2 offload credentials. The deploy renderer
(`scripts/deploy-service-environment.ts`) renames Infisical keys into `kafka.env`
and **preserves Infisical dotenv quoting** on values. Static RSM/Aiven settings
are declarative in `deploy/stack.yml` / `docker-compose.yml` — not generated.

| Infisical | kafka.env |
|---|---|
| `KAFKA_CLUSTER_ID` | `CLUSTER_ID` |
| `KAFKA_TIERED_STORAGE_BUCKET` | `KAFKA_RSM_CONFIG_STORAGE_S3_BUCKET_NAME` |
| `KAFKA_TIERED_STORAGE_ENDPOINT` | `KAFKA_RSM_CONFIG_STORAGE_S3_ENDPOINT_URL` |
| `KAFKA_TIERED_STORAGE_REGION` | `KAFKA_RSM_CONFIG_STORAGE_S3_REGION` (`auto`) |
| `KAFKA_TIERED_STORAGE_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` (default chain) |
| `KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` (default chain) |

Stack/compose also set (declarative, dual512-fix PASS envelope
[`CORE_PROOF.json`](../../docs/evidence/kafka-ts-dual512-fix-20261106/CORE_PROOF.json)):
`AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`,
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`, RSM class path/names, chunk
`4194304`, `MemoryChunkCache` `67108864`, prefetch max `4194304`, path-style
`true`, RLMM RF/min ISR `1`/`1`.

**Never** set `KAFKA_RSM_CONFIG_STORAGE_AWS_*` static secret fields.
**Never** reuse JSONL archive `R2_*` or erasure-ledger keys.

`KAFKA_CLUSTER_ID` is stable (no regeneration on restart or apply). Operator
bootstrap used stock `kafka-storage.sh random-uuid` in an external **384 MiB**
tool container (`--memory=384m`, no broker JVM) and Infisical
`secrets set --file /dev/stdin` via private pipe — see
[`docs/kafka-infisical-bootstrap-keys.md`](../../docs/kafka-infisical-bootstrap-keys.md).

## Topic desired config (B7 + deploy stock CLI — no Infisical topic renames)

Broker `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`. Global RSM enable does **not**
tier topics. Deploy must create v2 **main + `.quarantine.v1`** with stock
`kafka-topics.sh` in the **existing** external 384 MiB client (same pattern as
API readiness) — not README-only, not a custom CLI.

| Knob | Value | Source |
|---|---|---|
| partitions / RF | `1` / `1` | B7 + live/history design (one partition) |
| `cleanup.policy` | `delete` | quarantine contract (`kafka-quarantine.ts`) |
| `retention.ms` | `604800000` (7 d) | B7 / quarantine constants (whichever first with bytes) |
| `retention.bytes` | `1073741824` (1 GiB) | B7 / quarantine constants — remote is **not** a 7 d guarantee under the byte cap |
| `remote.storage.enable` | `true` | required for RSM tiering |
| `segment.bytes` | `33554432` (32 MiB) | Q13A; dual512 `size-and-segment-plan.json` |
| `segment.ms` | `3600000` (1 h) | Q13A finite time-roll |
| `local.retention.bytes` | `268435456` (256 MiB) | Q13A **async** eligibility after copy — not a hard ceiling; outage can exceed |

Topics: Infisical `METRIC_STREAM_{LEGACY,LIVE,HISTORY}_TOPIC` values **as already
provisioned**, plus `${topic}.quarantine.v1` for each **writable** main. Do **not**
change Infisical topic string values in this lane.

**Write-generation guard (reuse, not a new validator):** deploy create calls
[`assertWritableMetricStreamTopic`](../../src/metric-stream/routes.ts) (same
refuse list as producers / `RETIRED_METRIC_STREAM_TOPIC_NAMES`).

New-cluster bootstrap (**one** `KAFKA_BROKERS` for every sink/archive): **fail-fast
all** legacy/live/history main routes (and matching archive env topics) if any
name is retired v1. B7 confirmed legacy sink+archive **remain deployed** — so
Infisical `METRIC_STREAM_LEGACY_TOPIC` must be a distinct **v2** name (with
live/history) before this bootstrap; no secret edits in this runtime wave.
Cutover order: drain old RP first → v2 names for **all** deployed routes →
switch `KAFKA_BROKERS`.

[`resolveMetricStreamConsumerRoutes`](../../src/metric-stream/consumer-routes.ts)
may still **allow** v1 for **pre-drain consume on the old cluster only** — do not
tighten that source assert; it is not a license to deploy v1 onto the new
cluster.

### Local vs remote disk (Q13A — CONFIG ONLY)

User approved Progress **Q13A** as **CONFIG ONLY** (topic-automation wiring),
**not** production deployment/cutover. Deploy stock `kafka-topics.sh` /
`kafka-configs.sh` reconcile the table above for every writable main +
`.quarantine.v1`.

`local.retention.bytes` is **async** RLM delete eligibility after remote copy —
**not** a hard local ceiling; offload outage / lag can retain more. **No** custom
disk monitor or backpressure framework — disk-full and consumer lag remain
explicit operational limitations.

**Planning estimate (not a guarantee)** when offload/GC keep up: active ≈ 6×32 MiB
= **192 MiB**; closed-local toward 6×256 MiB ≈ **1.5 GiB**; plus indexes (~10–20%)
and RLMM/remote-index-cache headroom → rough data-dir planning envelope
**~2.5–4 GiB**. Offload outage can grow toward the overall retention envelope
(up to ~6 GiB under `retention.bytes` ×6 + indexes). Observed prod Redpanda dir
≈ **38 GiB** ([capacity decision](../../docs/pulsar-production-capacity-decision.md))
— retain until separate deletion approval.

Host bind: `/mnt/dofek-data/kafka/data` owned **1000:1000** (`apache/kafka`
`appuser`); plugins tree world-readable after publish.

## Steady memory envelope (dual512-fix)

| Component | Limit | Evidence |
|---|---|---|
| Broker cgroup | **2048 MiB**, heap `-Xmx1G -Xms1G` | CORE_PROOF PASS |
| Local Seaweed (compose) | **1024 MiB** | lifetime peak **808.1 MiB** in CORE_PROOF — do not ship untested 512 MiB |
| External client tools | **384 MiB**, heap `-Xms32m -Xmx256m` | CORE_PROOF |

Prod memory budget: Kafka **2 GiB** replaces retired Redpanda **1500 MiB** hot-log
**allocation** on the single-node host (not HA). Allocation replacement ≠
automatic deletion of the old Redpanda data directory (see cutover below).

## Listeners

| Environment | Bootstrap |
|---|---|
| Local compose | Containers `kafka:29092`; host `127.0.0.1:${KAFKA_PORT}` |
| E2E | `kafka:29092` (transport path; TS qual is separate) |
| Production | `kafka:9092` |

## Readiness

Broker healthchecks are TCP port-liveness only (no operator JVM in broker cgroup).
Producers wait on external `kafka-broker-api-versions` (`kafka-ready` / deploy wait).

## JSONL archive (unchanged)

`deploy/redpanda/metric-stream-r2-archive.connect.yml` → existing archive bucket
`dofek-metric-stream-archive`. Separate from `dofek-kafka-ts-offload`.

## Topic generation (archive-safe)

Writers/sinks/archive use **v2** topic names so Connect keys cannot overwrite
historical v1 R2 objects when offsets restart at 0.

## Operator cutover — Redpanda hot-log retain (not executed here)

Stopping Redpanda **stops retention GC** on `/mnt/dofek-data/redpanda` (or the
compose volume). Those bytes do **not** age out after the process is down.
Kafka TS / R2 offload proof does **not** cover old hot-log physical absence.

| Class | Operator requirement | Non-claims |
|---|---|---|
| Before stop | Reconcile JSONL archive + sink/consumer drain against Redpanda HWM so the archive holds the last intended offsets | Not dual-write; no custom bridge |
| Pre–Kafka-write rollback | If Kafka has **not** accepted production writes, stock rollback can restore Redpanda listeners/`REDPANDA_BROKERS` with retained data dir (still subject to erasure deadlines) | Not an automatic flip |
| Post–Kafka-write (v2) | New v2 topics have no automatic flipback to Redpanda; treat as forward-only unless Root approves a separate recovery plan | No DIY dual-write |
| Retain hold | Keep the stopped Redpanda data directory until **measured** size/age bounds and erasure deadlines are known; if unknown, document an explicit retain hold — do **not** claim physical absence | Silent forever retention while claiming erasure is forbidden |
| Exact old-data retirement | Deleting the Redpanda data directory (or equivalent host wipe) requires **separate explicit production deletion approval** after archive/drain evidence | **No retire execution** in this runtime wave |

Erasure / physical-absence attestations must name **which** store was checked
(Redpanda hot-log vs Kafka local vs Kafka TS R2 vs JSONL archive). Passing
Kafka-TS remote delete labs does not retire Redpanda bytes.

## Qualification

Local Seaweed native retention/Delete (MPU-sized closed segment, main +
quarantine, RLMM COPY/DELETE FINISHED, local+remote+MPU absence) is authorized
as stock Kafka strategy under dual512-fix bounds — see
[`docs/kafka-ts-r2-qualification-manifest.md`](../../docs/kafka-ts-r2-qualification-manifest.md).
Cloud R2 MPU/delete budget remains a separate Root gate. No production cutover
from this packet.
