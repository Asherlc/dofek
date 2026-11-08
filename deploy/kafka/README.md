# Stock Kafka (runtime)

Official [`apache/kafka:4.4.0`](https://hub.docker.com/r/apache/kafka) + released
[Aiven tiered-storage-for-apache-kafka v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0).
No custom broker image.

Design authority: [`docs/kafka-tiered-storage-assessment.md`](../../docs/kafka-tiered-storage-assessment.md).
IaC contract (bucket/token/Infisical): [`docs/kafka-ts-r2-offload-iac.md`](../../docs/kafka-ts-r2-offload-iac.md).

**Terraform provisioning: DONE** (apply
[42339969701](https://github.com/Asherlc/dofek/actions/runs/42339969701);
receipts under
[`docs/evidence/kafka-infra-plan-review-20261107/`](../../docs/evidence/kafka-infra-plan-review-20261107/);
docs close `c31048ccf`). `KAFKA_CLUSTER_ID` + `KAFKA_BROKERS` are **resolved**
(Root-provisioned; see
[`docs/kafka-infisical-bootstrap-keys.md`](../../docs/kafka-infisical-bootstrap-keys.md));
do **not** regenerate the cluster id. RSM is the steady production
configuration (enabled); there is no TS-off stopgap in stack.

**Production cutover / merge / topic-value edits / old Redpanda data-dir
deletion: NOT APPROVED.** Review-only sequence below. Do not execute from this
doc alone.

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

Post-cutover memory budget: Kafka **2 GiB** is intended to replace the live
Redpanda **1500 MiB** hot-log **allocation** on the single-node host (not HA).
Production still runs Redpanda today. Allocation replacement ≠ automatic
deletion of `/mnt/dofek-data/redpanda` (see cutover below).

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

## Production cutover + rollback review (NOT EXECUTED)

Authority for this review: stock Swarm / Infisical / existing
`deploy-web-stack` topic reconcile / freshness commands in
[`docs/metric-stream-redpanda-r2-runbook.md`](../../docs/metric-stream-redpanda-r2-runbook.md).
**No** dual-write, **no** custom bridge, **no** new validator or evidence
protocol. Lane 87 supplies **readonly live baseline** (HWMs, lags, dir sizes,
current Infisical topic **names**); this lane does **not** duplicate production
SSH. Unknown measured gates → **fail closed** (do not invent limits).

### Status snapshot

| Gate | State |
|---|---|
| TF / Infisical `KAFKA_TIERED_STORAGE_*` ×5 | **DONE** — [apply-verification.json](../../docs/evidence/kafka-infra-plan-review-20261107/apply-verification.json) |
| Bucket `dofek-kafka-ts-offload` | **DONE** — HEAD 200, ListObjects 0 at verify |
| Retired `dofek-pulsar-qualification` | **GONE** — HEAD 404 after approved cleanup+destroy |
| `KAFKA_CLUSTER_ID` / `KAFKA_BROKERS` | **Resolved** — do not regenerate |
| Distinct v2 `METRIC_STREAM_*` for **all** routes | **Pending approval** (secret value edits) |
| Drain + cutover execution | **Not approved** |
| `/mnt/dofek-data/redpanda` deletion | **Not approved** — retain |

### Required approvals (before any step that mutates prod)

| Decision | Who | Notes |
|---|---|---|
| A. Execute cutover window | User / Root | This review alone is insufficient |
| B. Infisical `METRIC_STREAM_{LEGACY,LIVE,HISTORY}_TOPIC` → distinct **v2** names for **all** deployed sink+archive routes | User / Root | Irreversible for writers once Kafka accepts produce; assessment names: `metric-stream-v2` / `metric-stream-live-v2` / `metric-stream-history-v2` ([assessment](../../docs/kafka-tiered-storage-assessment.md)) |
| C. Downtime / producer pause method | User / Root | Stock `docker service scale` of `dofek_web` / `dofek_worker` / `dofek_training-export-worker` (see [timescaledb pause pattern](../../docs/metric-stream-timescaledb-runbook.md)) **or** an already-approved hold — do not invent a new pause framework. Census: producers still `REDPANDA_BROKERS`-keyed; pause is a **separate explicit change** before STOP RP ([STOP-BEFORE-START](../../docs/pulsar-production-capacity-decision.md#stop-before-start-sequence-concrete-not-executed)) |
| D. Accept post–Kafka-write forward-only boundary | User / Root | No automatic rollback/redeliver without separate dedup-proven recovery plan |
| E. Explicit history-CH unread disposition | User / Root | User approved history-only recovery Q15; repaired consumer deployed on the existing Redpanda broker. At **2026-11-08T02:51:55Z**, history sink **1/1 Stable**, CURRENT `70659268`, LOG-START `55609019`, HWM `74445631`, lag **3,786,363**; all other serving/archive groups lag 0. This consumer now uses the canonical Kafka broker key pointed at Redpanda; no broker cutover occurred. Frozen incoming IDs and retained deletion candidates passed identity checks. Drain completion remains unproved; unrelated IDs and archive replay are not certified. See the [deletion-candidate result](../../docs/clickhouse-metric-stream.md#frozen-backlog-deletion-candidate-identity-audit--passed). |
| F. Later: delete `/mnt/dofek-data/redpanda` | User / Root | Separate from cutover; retain (**38 GiB** measured) |
| G. Re-enable Deploy Web | User / Root | Census: `.github/workflows/deploy-web.yml` state **`disabled_manually`** |

### Historical baseline (2026-11-07T05:08:43Z, with the early drain sample)

This census predates the deletion-timeout safety stop. Decision E above and
the incident record describe the later hold; the older draining figures below
are historical evidence. Re-run stock commands immediately before any mutation.
IaC Kafka R2 + five keys were verified separately and are not re-audited here.

| Fact | Census |
|---|---|
| Topics (1p/RF1) | Still **v1**: `metric-stream-v1`, `metric-stream-live-v1`, `metric-stream-history-v1` + matching `.quarantine.v1` |
| Producers | web/worker: `REDPANDA_BROKERS` + topic keys; **no** `KAFKA_*` on web/worker |
| Consumers | sinks/archives: `REDPANDA_BROKERS`; Kafka Swarm service **ABSENT**; `/mnt/dofek-data/kafka` **ABSENT** |
| Lag PASS | live+legacy CH + all three archives **TOTAL-LAG 0** (Stable) |
| Lag FAIL/GAP (draining) | `metric-stream-history-clickhouse-sink` **1/1** Stable; @05:34:02Z CURRENT **55,656,064** (from 55,609,019); LOG-START **55,609,019**; TOTAL-LAG **18,789,567**; live/legacy lag **0**; OOR **0**. Catch-up not claimed until lag → 0 |
| HWM preserve | legacy `1619570368`; live `243195275` (log-start 194021919); history `74445631` |
| RP datadir | `/mnt/dofek-data/redpanda` **du 38G**, owner `messagebus:messagebus` — **retain** |
| Host | MemTotal ~23.4 GiB; MemAvailable ~14.4 GiB; `/mnt/dofek-data` 147G **77%** used |
| Collector | 1/1; memory limit **unlimited** — capacity risk if Pulsar 4352 MiB add still considered; Kafka-only add is 2048 MiB |
| CH freshness | Bare `max(recorded_at)` ≈ **2092-10-22** — **unusable**; use `max(ingested_at)` + **lag** for drain/catch-up proof |
| Archive object age | **Not checked** (no ListObjects / no body GET this census) — GAP |
| Axiom | MCP **needsAuth** this session — rely on `docker service logs` + `rpk` until restored |
| Deploy Web | workflow **disabled_manually** |

**Blockers still open (fail closed):** approvals B/C/E/G; producer pause not done;
history-CH disposition; usable CH freshness alternate; R2 newest-object age
(names/LastModified only); uncapped collector acknowledged; Kafka not on host
yet (expected until approved deploy).

### Stock operator sequence (review only — do not run)

Order is mandatory. **No dual-write** at any step (never `REDPANDA_BROKERS` and
`KAFKA_BROKERS` producers together; never same-topic resume into archive).

1. **Freeze baseline** — Use the Lane 87 census above; **re-record** HWMs/lags
   with the stock commands in that census message immediately before mutate.
   Confirm TF receipts still match
   [apply-verification.json](../../docs/evidence/kafka-infra-plan-review-20261107/apply-verification.json).
2. **Pause producer ingress** — After approval **C**, scale metric-stream
   producers to 0 (or engage approved hold). Confirm no new publishes
   (lag stable / HWM frozen). Downtime starts here for live Apple/sensor
   metric-stream paths; PeerDB/CDC and non-metric-stream traffic are out of
   this path but still share host RAM.
3. **Drain old Redpanda** — Keep sinks+archives up. Prove live+legacy CH and
   all three archives at **lag 0** (census already PASS — re-prove after pause).
   History CH remains **GAP** unless approval **E** accepts unread-with-R2 or
   restores the sink. Prefer `rpk group describe` + service logs; **do not**
   use bare CH `max(recorded_at)` as freshness (prefer lag + `max(ingested_at)`). Quarantine inspect only via
   stock `rpk topic consume` if needed — no quarantine migrator.
4. **Preserve offsets** — Record main+quarantine HWM and archive
   first/last offset identity from the baseline. Do **not** delete Redpanda
   data. Stopping Redpanda **stops retention GC** on `/mnt/dofek-data/redpanda`;
   those bytes do **not** age out after the process is down.
5. **Distinct v2 all routes** — After approval **B**, set Infisical
   `METRIC_STREAM_*` to distinct v2 names for **legacy, live, and history**
   (sink and archive must match per route). Quarantine names follow
   `${main}.quarantine.v1`. Do **not** change `KAFKA_CLUSTER_ID`.
6. **Deploy Kafka + Q13A disk policy** — Existing Deploy Web / stack path only:
   publish plugins if absent, `chown 1000:1000` data dir, start `kafka`,
   external client reconciles writable main+quarantine with
   `remote.storage.enable=true`, B7 retention, Q13A
   `segment.bytes=33554432` / `segment.ms=3600000` /
   `local.retention.bytes=268435456` (async — **not** a hard local ceiling).
   Bootstrap env is `KAFKA_BROKERS` only (no `REDPANDA_BROKERS` alias).
7. **Point consumers / scale sinks** — Stock stack services already keyed off
   renderer env; restore desired replicas for the three CH sinks + three
   archives against Kafka. Confirm API readiness via external
   `kafka-broker-api-versions` wait (not broker-cgroup JVM).
8. **Enable producers** — Restore web/worker/(training-export) replicas or
   release hold **only after** topic describe proves required configs and
   consumers are attached. First production Kafka write crosses the rollback
   boundary below.
9. **Verify (stock)** — After enable, within the dual512-fix envelope
   (broker cgroup **2048 MiB**):
   - R2 **copy**: objects under `dofek-kafka-ts-offload` for closed segments
     (ListObjects / lab-shaped keys only; no body GET required for presence).
   - **Remote read**: consume after local segment eligibility (stock client).
   - **Native GC**: RLMM / remote absence only with existing
     [RLMM dump procedure](../../docs/kafka-ts-rlmm-dump-procedure.md) if
     needed — do not claim prod GC from lab `20261107c` alone.
   - **Memory/disk**: broker `memory.current`/`peak` under 2048 MiB; data-dir
     growth vs Q13A planning envelope (~2.5–4 GiB when offload keeps up;
     outage can grow toward retention envelope — **unknown hard stop** until
     measured). JSONL archive bucket remains `dofek-metric-stream-archive`
     (separate creds).

### Rollback boundary

| Phase | Allowed stock rollback | Forbidden claims |
|---|---|---|
| **Pre–Kafka-write** (pause+drain done; Kafka may be up; **no** prod produce yet) | Scale Redpanda + sinks back; restore prior Infisical topic names / `REDPANDA_BROKERS` if still the live producer bootstrap; leave Kafka unused | Not “automatic”; still subject to erasure deadlines on retained RP bytes |
| **Post–Kafka-write** (any successful produce to v2 on Kafka) | **Forward-only** by default. Re-enable Redpanda only under a **separate** Root-approved recovery that names dedup/idempotency evidence for ClickHouse+archive (sinks are duplicate-tolerant for inserts, but that is **not** proof that a full redeliver is safe without a reviewed plan) | No automatic flipback; no DIY dual-write; no promised redeliver |
| **Always** | Retain `/mnt/dofek-data/redpanda` (**38 GiB** census) until approval **F** | Kafka TS lab delete ≠ Redpanda physical absence |

### Irreversible / downtime points

| Point | Effect |
|---|---|
| Producer pause (step 2) | Metric-stream ingest downtime begins |
| Infisical v2 rename (step 5) | Old v1 names must not receive new writes; archive objects stay generation-keyed |
| First Kafka produce (step 8) | Enters post–Kafka-write forward-only class |
| Scale Redpanda to 0 | Hot-log GC stops; retain data dir |
| Delete RP data dir | **Not in this cutover** — separate approval **F** |
| Deploy Web still disabled | Cutover deploy path needs approval **G** to re-enable workflow |

### Non-goals (explicit)

- No production cutover execution from this document.
- No CI / `src` / test changes; no new cloud tests.
- No custom migration state machine, pause framework, or bridge.
- No claim that R2 JSONL replay is operator-ready (still unimplemented —
  [Replay](../../docs/metric-stream-redpanda-r2-runbook.md#replay)).
- Erasure / physical-absence attestations must name **which** store was checked
  (Redpanda hot-log vs Kafka local vs Kafka TS R2 vs JSONL archive).

## Qualification

Local Seaweed native retention/Delete (MPU-sized closed segment, main +
quarantine, RLMM COPY/DELETE FINISHED, local+remote+MPU absence) is authorized
as stock Kafka strategy under dual512-fix bounds — see
[`docs/kafka-ts-r2-qualification-manifest.md`](../../docs/kafka-ts-r2-qualification-manifest.md).
Cloud R2 MPU/delete budget remains a separate Root gate. No production cutover
from this packet.
