# Kafka tiered storage — stock assessment (authorized lab bounds)

**Status:** assessment + completed **small functional** local lab
(`kafka-ts-lab-20261106`, CORE_PROOF_PASS). Evidence:
[`docs/evidence/kafka-ts-lab-20261106/`](evidence/kafka-ts-lab-20261106/).
**No** adoption/pivot. **No** RAM comparison to the Pulsar 256 MiB fixture.
Next dual-topic lab is **planned only** (no allocation) pending a size-limit
decision below.

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

## Next lab plan (no allocation) — dual overlapping tier

**Intent (Root-requested, not started):** apples-to-apples **workload shape**
vs Pulsar `minio-mem2g-4` — **two topics**, **128 distinct ~1 MiB messages
each**, overlapping tier/upload — under **unchanged** Kafka **2048 MiB**
cgroup + **1 GiB** heap, Seaweed **1024 MiB**, tool **≤384 MiB**, wall
**≤45 min**, owned data **≤2 GiB**, preflight headroom **≥6 GiB**. Local
stand-in only; **zero B2**. Still investigation-only.

### Stock size defaults vs 1 MiB records (decision required)

| Config | Default | Source |
|---|---:|---|
| Broker `message.max.bytes` | **1048588** (1 MiB + **12** bytes) | [Broker configs 4.4](https://kafka.apache.org/44/configuration/broker-configs/) |
| Broker `socket.request.max.bytes` | **104857600** (100 MiB) | same |
| Producer `max.request.size` | **1048576** (exactly 1 MiB) | [Producer configs 4.4](https://kafka.apache.org/44/configuration/producer-configs/) |

A **1048576-byte value** plus Kafka record-batch framing (batch header +
per-record length/timestamp/key/headers overhead, typically **tens of bytes**)
exceeds producer `max.request.size` (1048576) and can exceed broker
`message.max.bytes` (1048588). Therefore **true 1 MiB values are not safe
under stock producer/broker defaults** without a **lab-scoped** bump of
`max.request.size` and topic `max.message.bytes` / broker `message.max.bytes`.
That bump must **not** be silent and must **not** change production Swarm
limits.

**Decision before allocation (pick one):**

| Option | Approach | Trade-off |
|---|---|---|
| **D1** | Lab-only raise producer `max.request.size` + topic `max.message.bytes` (and broker `message.max.bytes` if needed) just enough for 128×1 MiB values × 2 topics | Closest message-shape match to Pulsar; **explicit lab limit bump** (not prod) |
| **D2** | Keep **all** stock size defaults; match **total user bytes** (2 × 128 MiB = 256 MiB) with a smaller `record-size` that fits defaults (e.g. 512 KiB × 256/topic) | No size-limit bump; weaker per-message shape match |

No allocation until Root picks **D1** or **D2**.

### Plugin / RLM parallelism defaults (not fake equal MPU)

Documented defaults — do **not** assume parity with Pulsar `jclouds.mpu.parts.size=5 MiB`
or `managedLedgerOffloadMaxThreads=2`:

| Setting | Default | Notes |
|---|---:|---|
| Aiven `chunk.size` | **required** (demo/README uses **4 MiB**) | [Aiven configs](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst) |
| Aiven `storage.s3.multipart.upload.part.size` | **26214400** (25 MiB) | Segments **&lt; 25 MiB** typically upload as **single-part** PUTs — first lab’s ~1 MiB segments were single-part |
| Aiven `upload.rate.limit.bytes.per.second` | **null** (unlimited) | Optional throttle |
| Kafka `remote.log.manager.copier.thread.pool.size` | **10** | [TS configs 4.4](https://kafka.apache.org/44/configuration/tiered-storage-configs/) |
| Kafka `remote.log.manager.expiration.thread.pool.size` | **10** | same |
| Kafka `remote.log.reader.threads` | **10** | same |
| Kafka `remote.log.manager.task.interval.ms` | **30000** | Lab may lower for speed only if Root allows |

Overlapping dual-topic tier exercises **copier pool concurrency across
partitions/topics**, not “equal MPU part count” vs Pulsar.

### Manifest sketch (after D1/D2)

- Same stock images/plugin digests as `kafka-ts-lab-20261106`.
- Topics A/B, `remote.storage.enable=true`, small `segment.bytes` to force rolls,
  `local.retention.*` so closed locals delete after upload.
- Overlapping produce + wait for dual remote inventory + local removal; dual
  digests; broker restart; re-digest; cgroup lifetime peaks/events; cleanup.
- Stop on first OOM/fatal; no automatic limit increase; no B2.

## Conclusion

Stock Kafka **4.4.0** + Aiven **v1.2.0** remains a **credible, off-the-shelf**
candidate for a **tiered Kafka-protocol buffer** while **keeping the existing
R2 JSONL archive**. The small functional lab **passed** under 2048 MiB Kafka
cgroup with lifetime peaks well below limit; that is **not** a Pulsar RAM
comparison or production qualification. B2 compatibility remains
**unqualified**. Erasure must still cover tiered object versions. Next gated
step: Root chooses **D1** or **D2** for the dual-128 overlapping lab — **no
allocation** until then.

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
