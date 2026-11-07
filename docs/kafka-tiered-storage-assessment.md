# Kafka tiered storage — stock assessment (authorized lab bounds)

**Status:** small functional lab **PASS**; D2 dual-512 KiB comparison **FAIL**
(cgroup OOM on earliest remote consume). Evidence:
[`kafka-ts-lab-20261106`](evidence/kafka-ts-lab-20261106/),
[`kafka-ts-dual512-20261106`](evidence/kafka-ts-dual512-20261106/) (+ `RCA.json`).
**No** adoption/pivot. **No** automatic cgroup raise. Larger Kafka memory on
the current host is **UNQUALIFIED** (cloud tiny proofs would not production-qualify
it). **No** further lab until Root reviews the one same-2 GiB retest proposal.

**Intended architecture under study:** Kafka-protocol **tiered hot buffer**
(local segments + remote object store for closed segments) **plus the existing
Cloudflare R2 JSONL archive**, which remains the canonical durable
application archive
([metric-stream runbook](metric-stream-redpanda-r2-runbook.md)).
Tiered storage is **not** a candidate to replace that JSONL archive.

Pulsar/B2 foundation work remains a **separate** paused capacity track, not
canceled. This assessment treats Kafka tiered storage as a possible
**replacement for Redpanda’s role** (Kafka-protocol hot log), not as something
that must fit beside Pulsar on the same host.

## Recommendation (evidence-based)

**Credible stock candidate for further lab work:** Apache Kafka **4.4.0** KRaft
+ Aiven **v1.2.0** `RemoteStorageManager` S3 backend (released jars only), with
the **existing R2 JSONL archive kept**.

| Claim | Verdict |
|---|---|
| Stock path exists (no custom RSM/SDK) | **Yes** — Kafka ships the TS feature; Aiven ships Apache-2.0 plugin artifacts |
| KafkaJS clients can stay on Kafka protocol | **Plausible** — TS is client-transparent ([Kafka 4.4 TS](https://kafka.apache.org/44/operations/tiered-storage/)); **not** a drop-in broker-swap guarantee |
| Host memory fit vs current RP **1500 MiB** or vs Pulsar lab **4352 MiB** | **Unknown until measurement** — hardware prose does **not** prove fit or relative size |
| Replaces need for JSONL archive | **No — and that is intentional** (JSONL stays canonical) |
| Erasure may ignore tiered remote copies if JSONL is erased | **No** — personal bytes in tiered segments must still meet retention/delete deadlines |

**Do not** treat missing OpenSSF Scorecard as an automatic blocker; record it as
**unknown**. **Do not** invent dual-write bridges or seek design approval for
cutover in this packet — cutover remains later and unqualified; Redpanda data
can be retained and drained under existing stock procedures when that work is
explicitly opened.

This lab answers the user’s Kafka-TS investigation question. It is **not**
adoption, pivot, production qualification, or a claim of history on success.

## Goal and non-goals

**Goal:** evaluate whether stock Kafka KRaft tiered storage can serve as the
**bounded local + remote tiered buffer** while **R2 JSONL archives continue**
as today.

**Non-goals:** replacing JSONL; replacing Pulsar decision; custom segment
parsers for erasure; custom plugin builds; production cutover; B2/cloud object
traffic; dual-write/new bridges; disk-fill drills before core proof.

## Erasure and retention (all personal bytes)

Account erasure / retention deadlines apply to **every** copy of personal data,
including:

- local broker segments,
- **remote tiered segment objects** (and all object-store **versions**),
- and the existing JSONL archive objects.

Keeping JSONL as the canonical archive does **not** excuse leaving personal
bytes in the tiered cold copy past the deadline. Required controls (same bar
as other brokers):

1. **Bounded broker retention** (`retention.ms` / `retention.bytes` and
   `local.retention.*`) so remote+local copies expire on a known schedule
   ([Kafka 4.4 TS topic configs](https://kafka.apache.org/44/operations/tiered-storage/)).
2. **Inventory** of remote object keys (and versions) for the tier prefix.
3. **All-version cleanup** on the object store before the deadline (for B2:
   version listing + per-version delete; hide-by-name is insufficient
   ([B2 file versions](https://www.backblaze.com/docs/cloud-storage-file-versions))).
4. **No custom segment-body parser** proposed here — rely on retention/delete
   of whole segment objects and store versioning, plus existing JSONL erasure
   for the archive path ([account-erasure runbook](account-erasure-runbook.md)).

## Apache Kafka 4.4.0 (primary docs)

Latest tag line used for this packet: **4.4.0**
([Apache Kafka tags](https://github.com/apache/kafka/tags);
Docker Hub tag probe `apache/kafka:4.4.0` returned HTTP 200 this session).

Primary operations docs for **current** limits:

- [Tiered Storage (4.4)](https://kafka.apache.org/44/operations/tiered-storage/)
- [Tiered storage configs (4.4)](https://kafka.apache.org/44/configuration/tiered-storage-configs/)
- [KRaft (4.4)](https://kafka.apache.org/44/operations/kraft/)
- [Hardware and OS (4.4)](https://kafka.apache.org/44/operations/hardware-and-os/)
- [KIP-405](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage)

**Feature facts (4.4 docs):** TS off by default
(`remote.log.storage.system.enable`, topic `remote.storage.enable`). Kafka
**does not** ship a production `RemoteStorageManager`. Default RLMM uses an
internal metadata topic; single-broker labs must set metadata replication /
min ISR to **1**. Optional upload delay via `remote.copy.lag.*` (KIP-1241).
Limitations: no compacted topics; disable TS on topics before broker-level
disable; admin clients ≥3.0; no segments missing producer snapshots.

**KRaft:** combined `broker,controller` is for small/dev use and **not
recommended for critical deployment**; controllers store metadata in memory
and on disk — docs “believe” ~5 GiB RAM + ~5 GiB metadata disk is enough for a
**typical** cluster ([KRaft deploying considerations](https://kafka.apache.org/44/operations/kraft/)).
That belief is **not** a measured single-node envelope for our workload.

**Hardware prose** ([Hardware and OS](https://kafka.apache.org/44/operations/hardware-and-os/))
describes example large machines and page-cache sizing heuristics. It does
**not** establish that Kafka cannot fit this host, nor that it is smaller or
larger than the Pulsar **4352 MiB** lab cgroup sum. Capacity remains
**unknown until measured**.

## Aiven plugin v1.2.0 — GitHub API verification

Queried `GET /repos/Aiven-Open/tiered-storage-for-apache-kafka/releases/tags/v1.2.0`
this session:

| Field | Value |
|---|---|
| `tag_name` | `v1.2.0` |
| `published_at` | `2026-11-06T11:18:29Z` |
| `draft` / `prerelease` | `false` / `false` |
| `target_commitish` | `e137a28c2b0d51d2f56a756e69ecb1417faf77a0` |
| Release URL | https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0 |
| License (repo) | Apache License 2.0 |

**Release assets (exact names):**
`core-1.2.0.tgz` / `.zip`, `s3-1.2.0.tgz` / `.zip`, `gcs-1.2.0.*`,
`azure-1.2.0.*`, `filesystem-1.2.0.*`.

Release notes state **build and unit-test coverage** for Kafka **4.2, 4.3, and
4.4** (plus Java 25 coverage for 4.4). That is **CI/build coverage**, **not** a
vendor production-compatibility guarantee for our workload or for B2.

Stock install for the lab: download **released** `core` + `s3` archives;
verify checksums / release provenance against the GitHub release API; extract
once; **read-only mount** into the broker classpath
(`remote.log.storage.manager.class.path`). **No** custom plugin build. If
stock artifacts or the official runner cannot be obtained within bounds,
**stop with evidence** — no DIY harness.

S3-compatible knobs (including custom endpoint / path-style / MPU part size)
are documented in
[configs.rst](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/main/docs/configs.rst).
Useful later for B2; **not** exercised against B2 in this lab (local
SeaweedFS stand-in only).

OpenSSF Scorecard: report **not found** this session → security posture
**unknown**, not a hard reject.

## B2 (deferred; not in this lab)

B2 documents S3-compatible SigV4, MPU, and versioning
([S3 API](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api),
[versions](https://www.backblaze.com/docs/cloud-storage-file-versions)).
This lab uses a **local** SeaweedFS S3 stand-in only. Any B2 canary requires a
**separate budget/approval** and is out of scope until then. **Zero** B2 and
**zero** other cloud object traffic for this investigation.

## App protocol / callers (migration scope note only)

**Production today:** Redpanda + `REDPANDA_BROKERS` / KafkaJS-era consumers and
Redpanda Connect JSONL archives ([runbook](metric-stream-redpanda-r2-runbook.md)).

**This branch:** foundation source already has Pulsar publisher/sink wiring —
orthogonal to whether Kafka TS is labbed as an **RP alternative**.

Client API transparency means KafkaJS **may** continue against Apache Kafka;
broker cutover, Connect behavior, and offsets still need their own later
qualification. **No** dual-write bridge is proposed here. When cutover is
eventually opened, retaining Redpanda data and draining with stock tools
remains available — details deferred.

## Shape comparison (configured / documented — not measured RSS)

| Component | Figure | Meaning |
|---|---|---|
| Current Redpanda Swarm limit | **1500 MiB** (`deploy/stack.yml`) | Today’s configured hot-log ceiling |
| Pulsar mem2g-4 lab cgroups | **4352 MiB** (2048+2048+128+128) | Local lab envelope; separate track |
| Kafka 4.4 hardware / KRaft prose | Large-host / ~5 GiB controller belief | **Not** a fit proof for this host |
| This investigation lab | Kafka **2048 MiB** + Seaweed **1024 MiB** + tool **≤384 MiB** | Functional probe only — **no pass assumption**, not prod sizing |

## Authorized local investigation lab (one slot)

**Purpose:** one **local**, **bounded** investigation answering whether stock
Kafka **4.4.0** + Aiven **v1.2.0** S3 plugin can tier and re-read against a
**local** SeaweedFS stand-in under a **2048 MiB** Kafka cgroup from the start.
**Not** adoption, pivot, Pulsar-equivalence, or production qualification.

| Bound | Value |
|---|---|
| Wall clock | **≤ 90 minutes** setup + core proof. Stop on first OOM/fatal; diagnose before any change. **No** blind retry. **No** second unconstrained / automatic limit-increase run. |
| Isolation | Existing repo Compose wrapper with a **dedicated `--project-suffix`**; **one** local runtime slot. Disposable named volumes only. |
| Preflight | Require **≥ 6 GiB** free RAM headroom and sufficient disk **before** allocation. Owned lab data **≤ 2 GiB** total. |
| Kafka image | Official **`apache/kafka:4.4.0`** only (pull if missing). **No** custom image/build. |
| Kafka topology | Single-node **combined** KRaft lab only (accept combined-mode caveat). |
| Kafka cgroup | **`memory: 2048M` from the start** (not unconstrained-within-host). |
| Kafka heap | Official `kafka-server-start.sh` default **`KAFKA_HEAP_OPTS="-Xmx1G -Xms1G"`** (bounded at the ≤1 GiB ceiling). Document actual process flags in lab evidence; do not raise above 1 GiB. |
| Plugin | Released **`core-1.2.0` + `s3-1.2.0`** from the GitHub release above; verify checksums/release provenance; extract once; **read-only mount**. No Gradle/plugin rebuild. |
| SeaweedFS | Local S3 stand-in **`mem_limit: 1024m`**. Empty bucket at start. |
| Tool container | Separate helper/tool service **≤ 384 MiB** (produce/consume/inventory only). |
| Cloud / B2 | **Zero** B2 and **zero** other cloud object traffic. No Codex keys, no production buckets. |
| Workload | **≤ 5 000** distinct **1 KiB** messages; functional-only. Explicitly **not** equivalent to Pulsar 256 MiB load or prod qualification. One non-compacted topic; small `segment.bytes` to force roll. |
| Core assertions | (1) Closed local segments **actually removed** before Earliest remote digest. (2) Count / order / digest after broker restart. (3) Object inventory of stand-in keys. (4) Lifetime cgroup `memory.peak` / `memory.events` for **all** lab services. |
| Explicitly **out** until separate approval | Disk-fill drills, credential-revoke drills, unbounded soak, multi-broker, B2 phase, production cutover, source-code changes, runtime config commits, foreign volume/host edits. |
| Cleanup | Mandatory owned teardown (`compose … down --volumes`); leave no foreign containers/volumes. |

If stock artifacts or the official runner cannot be obtained within these
bounds: **stop**, record evidence, and do **not** invent a DIY harness.

## November 6 local functional lab (`kafka-ts-lab-20261106`)

**Result:** CORE_PROOF_PASS (scoped functional proof only). Sanitized evidence:
[`docs/evidence/kafka-ts-lab-20261106/`](evidence/kafka-ts-lab-20261106/).

| Pin | Value |
|---|---|
| Kafka | `apache/kafka:4.4.0` @ `sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| Plugin | Aiven [v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0) `core-1.2.0.tgz` `sha256:14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` + `s3-1.2.0.tgz` `sha256:1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010` |
| Seaweed | `chrislusf/seaweedfs:4.48` @ `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` |
| Tool | `amazon/aws-cli:2.38.2` @ `sha256:5d39fd52f236ed01c5c25fba66c9aebcfc6cbb88e7bb1b727c5fe1f150540597` |
| Heap | `-Xmx1G -Xms1G` ([`kafka-server-start.sh` default](https://github.com/apache/kafka/blob/4.4.0/bin/kafka-server-start.sh)) |

**Verification:** closed local segments removed before earliest remote digest;
5000/5000 contiguous offsets; sha256
`a1cc5c88bfe4f73c8a665027752d81cbd5c2f12f8ad504457ecb6ef405bde616` matched
after broker restart; 15 stand-in objects; owned `compose down --volumes`
cleanup.

**Lifetime peaks (`memory.peak`):** kafka 809.2 / 2048 MiB; seaweed 107.1 /
1024 MiB; tool 64.4 / 384 MiB; all `oom`/`oom_kill`/`max` = 0. Peak is a
**lifetime** cgroup high-water mark (includes restart), not a Pulsar 256 MiB
RAM comparison. Periodic sampler coverage was sparse; oneshot peak/events are
authoritative ([cgroup v2 memory files](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)).

**Not claimed:** adoption, host fit, B2 compat (still unqualified; zero B2
this lab), equivalence to Pulsar dual-128×1 MiB fixture.

## D2 decision executed; dual-512 KiB lab FAIL + RCA

Root selected **D2** (same total bytes, smaller records; no size-limit bump).
Authorized lab ran and **failed**. Full sanitized packet:
[`docs/evidence/kafka-ts-dual512-20261106/`](evidence/kafka-ts-dual512-20261106/)
(`CORE_PROOF.json`, `RCA.json`).

### What passed vs failed

| Stage | Result |
|---|---|
| 2×256×512 KiB produce (stock `max.request.size` / `message.max.bytes`) | PASS |
| Remote tier + local closed-segment removal | PASS (10 remote `.log`; locals active-only `@256`) |
| Earliest digest | **FAIL** |
| Restart + re-digest | NOT REACHED |
| Automatic cgroup/heap raise | **Not done** |

### First fatal (exact)

```text
docker exec …/kafka-console-consumer.sh --topic topicA --from-beginning --max-messages 256
→ docker inspect: Status=exited Exit=137 OOM=true Finished=2026-11-06T21:57:40Z
→ broker log: 21:57:37Z console-consumer group join; 21:57:40Z death
→ no java.lang.OutOfMemoryError in broker log tail (cgroup kill, not logged Java heap OOM)
```

### JVM / cgroup facts (released scripts)

| Item | Evidence |
|---|---|
| One broker JVM | Official image `launch` → `kafka-server-start.sh` → `kafka.Kafka` |
| Broker heap | `KAFKA_HEAP_OPTS=-Xmx1G -Xms1G` ([kafka-server-start.sh](https://github.com/apache/kafka/blob/4.4.0/bin/kafka-server-start.sh)) |
| Explicit `MaxDirectMemorySize` | **Not set** (stock) |
| Default perf opts | G1 + CDS `kafka.jsa` ([kafka-run-class.sh](https://github.com/apache/kafka/blob/4.4.0/bin/kafka-run-class.sh) / image `launch`) |
| Digest client | `docker exec` **inside broker cgroup** |
| Client heap | Inherits container `KAFKA_HEAP_OPTS` because [console-consumer.sh](https://github.com/apache/kafka/blob/4.4.0/bin/kafka-console-consumer.sh) only sets `-Xmx512M` when unset → **second 1 GiB heap** in the same 2048 MiB cgroup |

### Plugin / RLM (configured vs default)

| Knob | This lab | Notes |
|---|---|---|
| `MemoryChunkCache` size | **64 MiB** | `readAllBytes()` into heap ([source](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/fetch/cache/MemoryChunkCache.java)) |
| Prefetch | **4 MiB** (functional lab used 1 MiB) | Still ≪ 256 MiB remote set |
| `chunk.size` | **4 MiB** | Same as functional lab |
| MPU part size | default **25 MiB** | Closed segments ~33 MiB → multi-part **eligible**; not an MPU stress proof |
| `remote.log.reader.threads` | default **10** | Unchanged; not forced to Pulsar `2` |
| `remote.log.reader.max.pending.tasks` | default **100** | Unchanged |
| `remote.log.index.file.cache.total.size.bytes` | default **1 GiB** disk cache under `remote-log-index-cache` (mmap on open) | [TS configs](https://kafka.apache.org/44/configuration/tiered-storage-configs/); [RemoteIndexCache](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/RemoteIndexCache.java) |

Consumer fetch left at stock (`fetch.max.bytes=50 MiB`,
`max.partition.fetch.bytes=1 MiB`); 512 KiB values fit — **no fetch bump**.

### ~5 MiB functional vs 256 MiB read (no handwave)

| | Functional PASS | D2 FAIL |
|---|---|---|
| User bytes | ~5 MiB | 256 MiB |
| Record size | 1 KiB | 512 KiB |
| Remote data at digest | small | all closed data remote |
| Digest method | same `docker exec` consumer pattern | same pattern |
| Observed | lifetime peak **809 MiB** | **OOM at consume start** after tier PASS |

Failure is tied to **earliest remote consume** (log timeline), not to upload.
Sampler **stalled** after ready — **no invented peak breakdown** for
pagecache/mmap/chunk split during consume (`cgroup-sample-summary.json`).

### Root cause (scoped)

**Primary (test violation, not a Kafka resource finding):** Root’s lab bounds
already required a **separate tool ≤384 MiB**. Running
`kafka-console-consumer` via `docker exec` **inside** the broker cgroup was an
**avoidable fixture error**. That client **inherited** broker
`KAFKA_HEAP_OPTS=-Xmx1G -Xms1G` ([console-consumer.sh](https://github.com/apache/kafka/blob/4.4.0/bin/kafka-console-consumer.sh)
only defaults to `-Xmx512M` when unset), placing a second 1 GiB heap beside the
broker in the same **2048 MiB** cgroup → cgroup OOM. **Do not** treat
`kafka-ts-dual512-20261106` as evidence that Kafka TS cannot serve 256 MiB
remote reads under 2 GiB.

**Contributing pressure (still real, unmeasured under a correct fixture):**
256 MiB remote earliest read vs ~5 MiB functional read.

**Not proven (gap):** exact MiB attribution among mmap index cache, page
cache, and chunk buffers (sampler gap); **and** broker-only RSS under a
correct out-of-cgroup client.

### Same-2 GiB fixture-correctness retest — **PASS**

Root ACK’d the retest. Packet:
[`docs/evidence/kafka-ts-dual512-fix-20261106/`](evidence/kafka-ts-dual512-fix-20261106/)
(`CORE_PROOF.json`).

| Keep unchanged | Fixture correction applied |
|---|---|
| Kafka **2048 MiB**, heap **`-Xmx1G -Xms1G`**, stock fetch, default RLM pools, chunk 4 MiB, MPU default, Seaweed 1024 MiB, same 2×256×512 KiB | **All** admin/producer/consumer JVMs in **separate client 384 MiB** with explicit `KAFKA_HEAP_OPTS=-Xms32m -Xmx256m`; single `kafka.Kafka` in broker cgroup (healthcheck `TopicCommand` disabled); clients sequenced |

| Stage | Result |
|---|---|
| Produce + remote tier + local closed removal | PASS (10 remote `.log`, 8× ~33 MiB multi-part-eligible; locals active-only `@256`) |
| Earliest digest A (client 384 / heap 256) | PASS |
| Broker restart + digest B match A | PASS |
| Broker / client / seaweed cgroup OOM | **none** (`oom=0`) |

**Lifetime peaks (MiB):** kafka **1628.5** / 2048; seaweed **808.1** / 1024;
client **195.8** / 384. Kafka peak from produce/tier; digest-phase kafka peaks
~1260 MiB with client isolated. Elapsed **~11 min** (≪ 45 min). No knob
tuning, no RAM raise, no source patch. Owned compose `down --volumes` done
(Docker slot released for B2).

**Digest provenance (mandatory):** first `hash-a.json` was corrupted by
`python3 … | tee hash-a.json` (preserved as `hash-a.malformed.raw`). Observed
digests were **not** reconstructed from that print. Fresh consumes retained
stdout bytes; `hash-a.json`/`hash-b.json` written only via `pathlib`; git
packet keeps `stdout-manifest-*.json` (sha256 of stdout) because full stdout
is ~128 MiB × 4.

**Claim update:** under a correct fixture, this host **can** complete the same
256 MiB remote earliest read + restart re-hash inside 2 GiB broker / 384 MiB
client without OOM. The confounded dual512 FAIL must **not** be reused as a
broker memory ceiling.

### Coordination note (B2 / R2 / cloud)

Host Kafka memory qualification for **larger-than-this** workloads remains
open. Cloud/B2/R2 proofs are still not production memory qualification.
Confounded dual512 OOM must not be cited as Kafka-broker inability.

## Conclusion

Stock Kafka **4.4.0** + Aiven **v1.2.0**: tier upload + local removal PASS;
~5 MiB remote read PASS; **fixture-correct** 2×256×512 KiB (256 MiB) earliest
remote digest + restart re-hash **PASS** under broker 2048 MiB / client 384 MiB.
Prior dual512 Exit 137 was a **test violation** (consumer inside broker
cgroup inheriting 1 GiB heap), not a Kafka resource finding. B2/R2 Phase F
packets remain historical evidence only — not production cutover authority.
TS object-store **provider choice still pending** Root answer.

## Current plan (Root conditional ACK — runtime-only)

User pivot: scrap Pulsar; integrate stock Kafka 4.4.0 + released Aiven RSM
1.2.0; **keep** existing R2 JSONL archive. **No production cutover** and **no
new cloud test** in this wave.

### Lane split

| Lane | Owns | Does not own |
|---|---|---|
| **This (runtime)** | `docker-compose*.yml`, `deploy/kafka/**`, `deploy/stack.yml` broker/archive wiring, host plugin publish step in existing deploy workflow, active deploy README + runtime CI that starts those compose services | Any `src/**`, package.json deps, unit/integration test bodies |
| **B7** | All src/package/test restoration and Pulsar file removal (incl. native integ / bookie), `KAFKA_BROKERS` rename across app/docs/tests, Infisical app env consumption, erasure deadlines for **Kafka TS cold objects** | Wholesale HEAD restore; DIY dual-write |
| **87** | Pulsar B2 offload IaC teardown (coord) | R2 archive buckets |

### Archive collision (critical)

Connect object keys are
`…/${topic}-${partition}-${first_offset}-${last_offset}.jsonl.gz`
([`deploy/redpanda/metric-stream-r2-archive.connect.yml`](../deploy/redpanda/metric-stream-r2-archive.connect.yml)).
A new Kafka cluster resets offsets to **0**. Reusing **v1** topic names would
**overwrite** existing R2 archive objects for overlapping offset ranges.

**Chosen stock-safe design (no DIY migration):** introduce a **new topic
generation** with the same grammar:

| Route | Retired (Redpanda / archive history) | Kafka generation (writers+sinks+archive) |
|---|---|---|
| legacy | `metric-stream-v1` | `metric-stream-v2` |
| live | `metric-stream-live-v1` | `metric-stream-live-v2` |
| history | `metric-stream-history-v1` | `metric-stream-history-v2` |

Do **not** resume same-topic produce into the existing archive. Quarantine
suffix grammar stays aligned (`*.quarantine.v1` → generation-matched names
under B7). Exact cutover sequencing is **documented only** until Root approves
runtime cutover; B7 owns app/topic env defaults. **No dual-write / custom
bridge.** Operator cutover must also account for the **stopped Redpanda data
directory** (see [`deploy/kafka/README.md`](../deploy/kafka/README.md)
cutover section):

1. **Archive + drain before stop** — reconcile JSONL archive and consumers to
   Redpanda HWM; then stop Redpanda. A stopped broker **does not** run retention
   GC on `/mnt/dofek-data/redpanda`.
2. **Rollback classes** — **pre–Kafka-write**: stock restore of Redpanda
   listeners / `REDPANDA_BROKERS` against the retained data dir may still be
   possible. **post–Kafka-write (v2)**: no automatic flipback; forward-only
   unless Root approves a separate recovery plan.
3. **Retain hold** — keep measured size/age bounds (or an explicit unknown hold)
   until erasure deadlines are satisfied. Do **not** claim physical absence
   while old hot-log bytes remain.
4. **Exact old-data retirement** — deleting the Redpanda data directory requires
   **separate explicit production deletion approval**. Not part of this runtime
   wave; not implied by Kafka TS / R2 GC labs.

### Env

Canonical bootstrap: **`KAFKA_BROKERS`** replacing `REDPANDA_BROKERS` — **no
alias/fallback**. Missing Infisical provision of `KAFKA_BROKERS` (and sink/archive
env files) **blocks merge/deploy**. B7 lands app reads; runtime compose/stack/Connect
emit `KAFKA_BROKERS` only.

### Plugin provision (existing host + workflow)

Pinned Aiven v1.2.0 assets (`core-1.2.0.tgz` /
`s3-1.2.0.tgz` sha256 as in lab provenance). Publish with **curl + sha256 verify
+ exact archive roots (`core-1.2.0/`, `s3-1.2.0/`) + atomic version-pair `mv`** into
`/mnt/dofek-data/kafka/plugins/1.2.0/{core,s3}` **if absent** on the existing prod
host via the existing deploy workflow SSH step — **not** cloud-init-only, **not** a
maintained installer CLI, **not** a custom broker image. Never `rm -rf` a version
in use; never `find | head` for extract roots. Broker mounts the plugins tree **RO**.

### Broker health / readiness

No operator Java inside the broker cgroup. Broker healthchecks are **TCP
port-liveness only**. Meaningful API readiness uses an **external**
`kafka-broker-api-versions` client (`kafka-ready` compose service; deploy workflow
wait on the stack network) before producers attach.

### Prod RSM (R2 selected)

User selected **R2**. Production stack declares steady RSM knobs in
`deploy/stack.yml`; `kafka.env` only renames Infisical `KAFKA_CLUSTER_ID` +
`KAFKA_TIERED_STORAGE_*` onto `CLUSTER_ID` / AWS default chain / RSM S3 fields
(fail-closed; no blank credential fallbacks; no TS-off stopgap). Never static
`KAFKA_RSM_CONFIG_STORAGE_AWS_*` secret configs. Include stock
`AWS_*_CHECKSUM_*=WHEN_REQUIRED` from Phase F. Topic
`remote.storage.enable=true` is topic config (B7), not a broker env invent.

### Listeners

Local: internal `kafka:29092` + host `127.0.0.1:${KAFKA_PORT:-19092}`. E2E:
`kafka:29092`. Prod: single `kafka:9092`. Do not advertise `kafka` hostname to
host clients.

### Qualification still required before TS in production

| Gate | Bar |
|---|---|
| MPU | **Actual** multipart observations (UploadPart / CompleteMultipartUpload), not “segment > part size ⇒ eligible” alone |
| Native delete / retention | Local removal + remote object lifecycle |
| Failure + restart | Digest match with stdout provenance rules |
| Backpressure | Lag without silent drop; fixture-correct client isolation — **not** claimed solved by unset `local.retention` |
| Stable metadata | Survives restart |
| Erasure | Topic retention **and** app-erasure cold-object deadlines include **Kafka TS** objects (B7), not only KafkaJS drain restore |
| Topic automation | Stock `kafka-topics.sh` / `kafka-configs.sh` in deploy external client: writable v2 main+quarantine for **all** legacy/live/history (+ archive match), `remote.storage.enable=true`, B7 retention 7 d/1 GiB (whichever first), 1p/RF1, Q13A `segment.bytes=32MiB` / `segment.ms=1h` / `local.retention.bytes=256MiB` (async, not hard ceiling). CONFIG ONLY — not cutover. Fail-fast retired v1 via `assertWritableMetricStreamTopic`. Host data dir `chown 1000:1000` (broker `appuser`). |

### Runtime wave (conditional runtime-only scope)

1. Provider-independent Kafka runtime config under `deploy/kafka/**` + compose/stack
   (S3 endpoint/bucket via env; **no** B2/R2 hardcode).
2. Remove Pulsar compose overlays and `deploy/pulsar/**`; preserve historical
   evidence docs as history.
3. Wire Connect/archive seed to `KAFKA_BROKERS`; default compose topics to **v2**.
4. Stop. No stack deploy, no cutover, no new cloud allocation.

**Status:** User selected **R2** as Kafka TS backend. Runtime maps Infisical
`KAFKA_TIERED_STORAGE_*` → AWS default chain + RSM S3 fields with RSM
**enabled** (fail-closed; dual512-fix CORE_PROOF knobs in stack/compose).
Dedicated bucket `dofek-kafka-ts-offload` is lane-87-owned; JSONL archive
unchanged. **Do not merge/deploy** until Infisical `KAFKA_BROKERS` +
`KAFKA_TIERED_STORAGE_*` + topics are provisioned and cutover is approved.
Local Seaweed native retention/Delete is authorized under the manifesto;
**cloud** R2 MPU/delete remains Root-budget gated. Cutover must retain the
stopped Redpanda data directory until separate deletion approval — see
[`deploy/kafka/README.md`](../deploy/kafka/README.md).

## Primary links (by claim)

| Claim | Link |
|---|---|
| KIP-405 | https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage |
| TS ops (4.4) | https://kafka.apache.org/44/operations/tiered-storage/ |
| TS configs (4.4) | https://kafka.apache.org/44/configuration/tiered-storage-configs/ |
| Broker configs (4.4) | https://kafka.apache.org/44/configuration/broker-configs/ |
| Producer configs (4.4) | https://kafka.apache.org/44/configuration/producer-configs/ |
| KRaft (4.4) | https://kafka.apache.org/44/operations/kraft/ |
| Hardware (4.4) | https://kafka.apache.org/44/operations/hardware-and-os/ |
| Aiven v1.2.0 release | https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0 |
| Aiven configs v1.2.0 | https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst |
| cgroup v2 memory.peak | https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files |
| B2 S3 API | https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api |
| B2 versions | https://www.backblaze.com/docs/cloud-storage-file-versions |
| Lab evidence | evidence/kafka-ts-lab-20261106/ |
| Metric-stream runbook | metric-stream-redpanda-r2-runbook.md |
| Account erasure | account-erasure-runbook.md |
| OpenSSF Scorecard | https://scorecard.dev/ (plugin report missing this session) |
