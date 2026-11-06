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

**Primary:** colocating the digest client in the broker cgroup with inherited
**1 GiB** `KAFKA_HEAP_OPTS` collides with the broker’s **1 GiB** heap inside
**2048 MiB** during heavy remote read (cgroup OOM).

**Contributing:** 256 MiB remote earliest read vs ~5 MiB functional read
(MemoryChunkCache / reader-pool / pagecache pressure scale with remote bytes).

**Not proven (gap):** exact MiB attribution among mmap index cache, page
cache, and chunk buffers (sampler gap).

### One minimum same-2 GiB retest (proposal only — no lab yet)

| Keep unchanged | Change only this |
|---|---|
| Kafka cgroup **2048 MiB**, heap **`-Xmx1G -Xms1G`**, stock consumer fetch, default RLM pools (10), chunk 4 MiB, MPU default | Run `kafka-console-consumer` **outside** the broker cgroup (tool container ≤384 MiB) with **explicit client** `KAFKA_HEAP_OPTS=-Xmx256M` (or `docker exec -e KAFKA_HEAP_OPTS=-Xmx256M`) |

Does **not** raise cgroup, does **not** silently tune RLM/fetch “until pass”.
Still not production qualification. **No allocation until Root ACKs.**

### Coordination note (B2 / R2 / cloud)

Larger Kafka memory on the **current host is UNQUALIFIED** after this OOM.
Any cloud/B2/R2 “tiny proof” must **not** be treated as production memory
qualification for Kafka TS on this host.

## Conclusion

Stock Kafka **4.4.0** + Aiven **v1.2.0** still shows a working **tier upload +
local removal** path under 2048 MiB, and a **passed** small (~5 MiB) remote
read. The D2 **256 MiB** earliest-read failed by **cgroup OOM** with a
same-cgroup 1 GiB client heap inheritance as the primary identified cause.
B2 compatibility remains unqualified. Next gated step: Root accept/reject the
**one** same-2 GiB client-isolation retest — **no lab until then**.

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
