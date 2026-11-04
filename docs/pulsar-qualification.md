# Single-server Pulsar qualification — 2026-11-03

**Decision: blocked before application migration or production deployment.**
The isolated topology works on ARM64. A narrow source correction to the bundled
offloader now passes actual Cloudflare R2 upload and readback; stock drivers
still fail. The proposed whole-host memory budget does not fit the current
service ceilings. This is evidence for Task 1 of the
[approved plan](superpowers/plans/2026-11-03-single-server-pulsar.md), not a
production certification or a completed resync. No production producer, sink,
retention, filesystem feature, or resource limit was changed.

## Acceptance results

| Gate | Result | Evidence / limit |
| --- | --- | --- |
| ARM64 images and Node native client | PASS | Pulsar 5.0.1, Oxia 0.18.0, official pulsar-client 1.18.0 on Node 26.13.0 / Alpine ARM64. |
| Persistent metadata / native transport | PASS, bounded fixture | Separate Oxia namespaces; 100 unacknowledged records survived abrupt termination and restart of all four processes. |
| S3 offload and local-ledger GC | PASS against local S3 only | 100 records read back after native GC removed the local BookKeeper ledger metadata. This does not certify R2. |
| Matched restore | PASS, stopped synthetic snapshot | 10,000 offloaded records restored in another Compose project/network, identical payload digest. |
| Mismatched metadata restore | PASS, refusal | Bookie refused a disk cookie whose instance ID differed from the metadata store. |
| Logical backlog quota | PASS as an eventual control | A new producer was rejected immediately; an existing producer sent 2,503 further 100-byte messages over 34,401 ms before rejection. Not a physical disk bound. |
| ext4 project quota enforcement | PASS in disposable host-kernel filesystem | Unprivileged writer hit EDQUOT at an 8 MiB directory budget while filesystem use was 8%. Root capability bypass was observed. |
| Production filesystem enablement | NOT QUALIFIED | Production ext4 has neither quota nor project features; maintenance, recoverable backups and enablement procedure remain prerequisites. |
| Bookie memory | 512 MiB FAIL; 768 MiB fixture PASS | 512 MiB hit a cgroup OOM during 10,000 × 8 KiB publishing. At 768 MiB the same workload passed, cgroup peak 688,697,344 bytes. |
| Whole production host resource fit | FAIL at current ceilings | Proposed capped steady services total about 23.992 GiB on a 23.413 GiB host, before uncapped services and host reserve. |
| Native offload to actual R2 | Source correction PASS, bounded fixture; stock FAIL | Corrected offloader uploaded ledger 25; native GC removed its BookKeeper metadata, broker replacement then read 10,000 messages continuously from R2 with matching digest. Stock drivers retain the failures below. |
| Broker memory | 768 MiB / one CPU fixture PASS | Continuous R2 readback peak 778,567,680 bytes, cgroup max/oom/oom_kill all zero. Unlimited-CPU lab broker previously exceeded this memory cap. |
| CDC consolidation assessment | Capture fixture PASS; retirement NOT QUALIFIED | Debezium Server snapshot, live changes and same-slot crash recovery passed within 512 MiB. Consumer semantics and complete host fit remain unresolved; see [assessment](pulsar-cdc-assessment.md). |
| R2 outage/interrupted-upload and full BookKeeper disk-exhaustion soak | NOT QUALIFIED | No claim from the smaller restart, quota or failed-authentication tests substitutes for these exercises. |
| Combined ClickHouse peak / web workload soak | NOT QUALIFIED | No production resource allocation passed; local transport fixtures are insufficient. |

## Tested topology and versions

[The qualification overlay](../docker-compose.pulsar.yml) has no published host
ports. It runs one Pulsar broker, one BookKeeper bookie, one Oxia data server and
one Raft coordinator; quorum and replication factor are one. Both Oxia processes
persist their state. Bootstrap details and the fresh-only BookKeeper formatting
boundary are in [deploy/pulsar/README.md](../deploy/pulsar/README.md).
These responsibilities follow the [Pulsar metadata architecture](https://pulsar.apache.org/docs/5.0.x/administration-zk-bk/)
and [Oxia deployment model](https://oxia-db.github.io/docs/deployment/bare-metal).

| Artifact | Pinned version / digest |
| --- | --- |
| Pulsar image | `apachepulsar/pulsar:5.0.1@sha256:4507075d8c11b34629f3a0b41f48e3c659951e601538562ee0c088cd2c737ec0` |
| Oxia image | `oxia/oxia:0.18.0@sha256:65f9898d531c3ca48a3277247650200c8065435fd542ea9a81e51c37b90fff60` |
| Client | Official `pulsar-client` 1.18.0, including the published musl ARM64 native binding |
| Fixture runtime | `node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94` |

Both service image indexes contain ARM64 manifests. A complete isolated npm
install of the client also connected successfully; testing only an unpacked
binding would not establish package installation compatibility. Upstream sources:
[Pulsar releases](https://github.com/apache/pulsar/releases),
[Oxia releases](https://github.com/oxia-db/oxia/releases),
[Node client configuration](https://pulsar.apache.org/docs/client-libraries/node-configs/).

The measured local candidate uses broker 768 MiB, bookie 768 MiB, Oxia server
128 MiB and coordinator 128 MiB: 1.75 GiB total, excluding the one-shot initializer,
client and local S3 stand-in. Bookie heap/direct limits are 192/128 MiB with
32 MiB write/read caches; broker heap/direct limits are 256/192 MiB with a
32 MiB managed-ledger cache. These are fixture inputs, not certified production
values. BookKeeper documents its independent heap, direct-memory and storage
controls in its [configuration reference](https://bookkeeper.apache.org/docs/reference/config/).

## Transport, offload and restore evidence

The larger deterministic fixture published 10,000 messages, each an 8,192-byte
buffer filled with `index % 251`, with the first four bytes replaced by the
unsigned message index in big-endian order. Batching was disabled and sends
were awaited. Total payload: 81,920,000 bytes; concatenated payload SHA-256:

```text
e0e1c3e34d2d4df91abaa2ac251981dc2e1a2cdaec29910327adac30e22ed84e
```

At the 768 MiB bookie cap, publishing took 24,925 ms. Matched restore read and
acknowledged 10,000/10,000 offloaded messages in 11,706 ms with the same digest;
broker logs explicitly opened ledger 16 from the offload driver. The snapshots
included BookKeeper, Oxia server state, coordinator Raft state and the local
object store, all stopped consistently before capture. They were restored into
empty named volumes **before creating containers**, because the S3 image can
populate a volume during container creation. Stable bookie hostname and matching
absolute journal/ledger paths were preserved.

With the original bookie volume mounted read-only against different fresh
metadata, native startup exited 2 with `BookieException$InvalidCookieException`:
disk instance `a15df492-4002-4e65-a78c-53256ed38936` did not match metadata instance
`a2718e81-9eb7-4ac7-b9a3-35badea25b29`. Earlier attempts failed DNS/path checks and
were not counted as proof of instance mismatch. No populated metadata was forced
or reformatted. See [BookKeeper metadata and recovery tools](https://bookkeeper.apache.org/docs/reference/cli/).

This proves the tested consistent-snapshot boundary, not zero RPO, sole-disk-loss
survival, an online backup procedure or reconstruction from R2 objects alone.
[Pulsar's offload mechanism](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/)
still depends on ledger metadata and does not offload the current open segment.

## Actual R2 stock failures and correction

Terraform created private bucket `dofek-pulsar-qualification` through the existing
Cloudflare state: **2 resources added, 0 changed, 0 destroyed**, including its
synthetic-data lifecycle (seven-day object expiration, one-day incomplete
multipart expiration). No existing archive bucket was used as a test target.
These lifecycle actions follow [Cloudflare's documented rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
Ordinary R2 storage/request charges can apply; see [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The same existing credentials successfully ran AWS SDK `HeadBucket`,
`ListObjectsV2`, `CreateMultipartUpload` and `AbortMultipartUpload` against this
bucket. Thus the failed native test cannot be attributed simply to missing
multipart write permission. Credentials and provider payloads were not included
in committed evidence.

1. **Generic `S3`, default signing:** native offload of a sealed 10,000-message
   ledger failed multipart initiation with HTTP 401. jclouds' generic driver
   [defaults to Signature V2](https://github.com/apache/jclouds/blob/master/apis/s3/src/main/java/org/jclouds/s3/S3ApiMetadata.java).
2. **Generic `S3`, supported `jclouds.s3.signer-version=4`:** initiation passed,
   but the first part failed before successful upload at 19:52:20 UTC with
   `unable to reset unrepeatable payload stream after calculating AWS4 signature`,
   caused by `java.io.IOException: mark/reset not supported`.
   The [Pulsar 5.0.1 offloader](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java)
   supplies an input-stream payload, while the
   [jclouds header signer](https://github.com/apache/jclouds/blob/master/apis/s3/src/main/java/org/jclouds/s3/filters/Aws4SignerForAuthorizationHeader.java)
   hashes and then resets a non-repeatable stream.
3. **Bundled `aws-s3`, custom R2 endpoint and explicit S3-specific fields:**
   the 100-message fixture reached R2 multipart part upload, which returned
   **HTTP 501 `NotImplemented`: `STREAMING-AWS4-HMAC-SHA256-PAYLOAD not implemented`**.
   An initial AWS-driver configuration selected empty legacy S3 fields before
   the generic fields; that failed attempt was corrected and is not the claimed
   R2 compatibility result. The native driver uses its
   [AWS signing implementation](https://github.com/apache/jclouds/blob/master/providers/aws-s3/src/main/java/org/jclouds/aws/s3/filters/AWSRequestAuthorizeSignatureV4.java).

The sealed ledgers remained marked `offloaded: false`. Following the failed
uploads, local reads verified all 10,000/10,000 large-fixture messages in 4,330 ms
with the original digest, and 100/100 AWS-driver fixture messages. This establishes
retention in these failures, not remote durability. Actual R2 GC/readback,
interrupted-upload recovery and outage soak therefore remain unqualified.
No custom offloader, signer patch, retry increase or alternative storage service
was introduced. Local containers holding real credentials were stopped and
removed without deleting named volumes; the temporary credential file was removed.

## Host memory and storage gates

At 19:55 UTC, the production host reported 25,139,458,048 bytes RAM (23.413 GiB),
no swap, and about 15.35 GB available. Available idle RAM is not a peak bound.
Current desired capped services total 26.707 GiB. Removing Redpanda (1.465 GiB)
and three archive services (3 GiB), adding the 1.75 GiB Pulsar candidate, retiring
the legacy 300 MiB sink and restoring the held 300 MiB history sink yields
**23.992 GiB**, before uncapped Redis, collector, OTA, Traefik, host memory,
temporary clients and migration overlap. No ceiling was lowered to make this
calculation pass. Container limit semantics are documented by
[Docker](https://docs.docker.com/engine/containers/resource_constraints/).

The current capped allocation, aggregated from each service's inspected limit
times desired replicas, is:

| Service group | MiB |
| --- | ---: |
| ClickHouse | 13,312 |
| Postgres | 2,048 |
| PeerDB, catalog, flow API/worker/snapshot worker, MinIO/lifecycle, Temporal/admin tools | 4,304 |
| Web (two replicas) and worker | 1,512 |
| Analytics worker, CDC health, Databasus and reconciliation | 1,000 |
| Live and legacy ClickHouse sinks | 600 |
| Three R2 archives | 3,072 |
| Redpanda | 1,500 |
| **Total capped desired** | **27,348** |

Stopped optional services and the held history sink contribute zero to that
current total. Uncapped services and temporary operator containers are separate,
not assumed to consume zero. Lowering existing ceilings requires workload
measurements; this qualification did not change them.

The 512 MiB bookie experiment failed at 19:26:21 UTC with exit 137,
`OOMKilled=true` and kernel `CONSTRAINT_MEMCG`; this was a container limit,
not evidence of a production OOM. At 768 MiB, native memory tracking recorded
383,420 KiB committed JVM memory, with additional native/file-cache costs;
observed cgroup peak was 688,697,344 bytes. A smaller smoke test had passed at
512 MiB, demonstrating why it could not certify the larger workload.

Production `/dev/sdb` is a 150 GiB ext4 device mounted without project/quota
features. A private mount namespace and disposable 128 MiB loopback filesystem
on the root disk tested project ID 4242 with an 8 MiB hard limit. An unprivileged
writer received EDQUOT after 7 MiB of payload; root with `CAP_SYS_RESOURCE` bypassed
the quota. Runtime identity/capabilities are therefore part of enforcement.
All loopback files, mounts and extracted quota tools were removed afterward;
no production package, filesystem feature or mount option changed. The local
Docker kernel lacks quota support, so its failed mount was not counted as a
production-kernel test. See [ext4 quota features](https://man7.org/linux/man-pages/man5/ext4.5.html)
and [capability semantics](https://man7.org/linux/man-pages/man7/capabilities.7.html).

## Production safety and next decision

At 19:51:39 UTC public health was ok, web was 2/2, worker 1/1, history sink 0/0;
data free space was 10,049,093,632 bytes and root free space 13,096,763,392 bytes.
The three owned queue pauses and history-sink hold remain intentional. Live Apple
Motion intake continues independently; the read-only sample exposed event
metadata only. No bulk work may resume on the strength of local qualification.

The current Pulsar strategy is not abandoned, but Task 1 cannot pass. The user
authorized fixing the demonstrated offloader failure; the source correction
below retains the existing Apache driver and native storage format. Further
application migration still requires a measured whole-host allocation with
reserve and overlap capacity, remaining failure exercises, and a safe production
physical-budget enablement/backup procedure. Tasks 2–7 have not started.

Conversion of **all existing R2 JSONL archives remains mandatory**. It must replay
original event bytes through Pulsar, preserve event IDs/versions, reconcile every
inventoried object and apply current erasure fences. Archive filenames contain
Kafka range boundaries, not a per-line offset; `firstOffset + lineIndex` must
never be invented. Native ledger objects and metadata must be created by the
broker. Original archives remain retained until separately reviewed retirement,
as specified in [Task 5](superpowers/plans/2026-11-03-single-server-pulsar.md#task-5-convert-all-existing-r2-archives-into-native-pulsar-storage).

The useful result is early rejection of two unsafe assumptions: idle RAM does not
prove resource fit, and a local S3 emulator does not prove R2 compatibility.
Future qualification should test actual object storage before application work,
and keep the four-hold restoration ledger in every incident handoff.

## Checkpoint validation

Compose merged-schema validation, Terraform 1.17.1 formatting/validation, lint
and root/server/web typechecks passed. SQLFluff retained its existing warnings
for four oversized SQL files; no limits were changed. No application source or
schema changed, so application test suites were not rerun for this configuration
and evidence checkpoint. The runtime fixture results above are the behavioral
qualification evidence; they do not convert the failed or untested gates to PASS.

## Corrected native offloader evidence

The regression test consumes the same multipart block and index payload twice
before delegating the upload. Stock source failed with `expected [2621442] but
found [0]`. The [source patch](../deploy/pulsar/repeatable-offload-payload.patch)
makes those sealed-ledger payloads repeatable byte arrays. It preserves block
and index layout; each data block is bounded by the configured 5 MiB size. The
separate streaming-offload path is unchanged. The original implementation and
signer are linked in the diagnosis above.

The full offloader test class passed **22 tests, zero failures/skips**, followed
by NAR packaging and main/test Java style checks on checksum-verified Temurin
25.0.5. The host run completed successfully in 2m 56s; its NAR SHA-256 is
`6a072864f5ac451a8f461af83af61f679d5f4f0535d522ebb85c3aefa436e2ee`.
The earlier Linux-built artifact used in the first actual-R2 proof had SHA-256
`fb2725a553d5003caa8e8e15ad90065b12c94b6e2e78dd998b9852d00ba394f8`.
These are separate builds of the same patch, not a reproducible-binary claim.
Packaging the host-tested artifact into the pinned broker base passed using
Docker's supported [named build-context stage override](https://docs.docker.com/reference/cli/docker/buildx/build/).
A cold full Docker source build remains unverified locally.

The resulting image was then started without a NAR bind mount or native-memory
tracking. An independent subscription read **10,000/10,000** previously offloaded
R2 records in **33,709 ms**, matching the same digest. Its broker cgroup peak
was **645,484,544 bytes**, with max/oom/oom_kill zero. Image configuration ID:
`sha256:109069c5909c6df8b264982f0d8f5c1879b96ce370d18ba58c2d047bd6e3b0e0`.
This verifies the packaged artifact's remote read path separately from the
earlier Linux artifact's upload/GC proof.

Actual R2 fixture `r2-fixed-stress-qualification` published the same 10,000 ×
8,192-byte deterministic payload in 25,446 ms. Native offload reported SUCCESS
for sealed ledger 25. BookKeeper's ledger list excluded 25, its metadata lookup
reported `BKNoSuchLedgerExistsOnMetadataServerException`, and a replacement
broker logged opening ledger 25 from the offload driver. No operator deleted
ledger metadata or data files.

A fresh independent subscription then read and acknowledged **10,000/10,000**
messages continuously in **26,866 ms**, matching the digest above. An earlier
attempt hit the fixture's existing 10-second receive deadline after 7,493
verified/acknowledged messages; its saved cursor resumed with the remaining
2,507 and matched the digest. No deadline was increased. The independent full
read is the stronger proof and does not erase the prior interruption.

The broker originally saw ten Docker VM CPUs, opened 232 threads and hit a real
768 MiB cgroup OOM during remote readback. A native one-CPU container limit
reduced its idle thread count to 101 with the same 256 MiB heap / 192 MiB direct
memory settings. The successful continuous R2 read used 104 threads and peaked
at 778,567,680 bytes, with cgroup `max=0`, `oom=0`, `oom_kill=0`. This included
temporary native-memory tracking, which is absent from the checked-in runtime
configuration. The [qualification overlay](../docker-compose.pulsar.yml) now
selects the patched broker build, one CPU and V4 signing. No production budget
was changed and this one fixture does not establish a long-duration peak bound.

## Qualification execution incidents

An additional diagnostic CLI JVM inside the tightly capped bookie was followed
by an OOM-marked test-container exit. Later diagnostics used its HTTP API or a
separate bounded attach process, preserving the actual service memory budget.

An unbounded Docker build overlapping runtime qualification exhausted the shared
Docker VM and interrupted local containers, including other workspaces'
ClickHouse tasks. Kernel evidence classified those events as global OOM; this
was local test infrastructure, not a production crash. The build was canceled
and this worktree's qualification runtime stopped. A dedicated 4 GiB builder
also encountered global pressure below its own cap (peak 3,493,724,160 bytes,
cgroup max/oom zero), so compilation moved to the 64 GiB macOS host. No other
workspace was deliberately stopped or removed. Future runs must reserve
aggregate VM headroom and separate source compilation from runtime stress.

## CDC and remaining gate

The user approved assessing retirement of PeerDB's service group through CDC
consolidation. [The assessment](pulsar-cdc-assessment.md) records a successful
stock Debezium capture/restart fixture, the 16-source/18-destination contract,
consumer limitations and the incomplete whole-host budget. It does not approve
or qualify production retirement. Existing-server fit, physical admission,
failure soaks, erasure/restore guarantees and all-archive conversion remain
required; the four production holds remain owned and unchanged.

The user's subsequent qualification request exercised released SeaTunnel 3.0.0
against actual ClickHouse 26.9.19. Official Debezium normalization enabled
versioned-row projection, reverse-order replay and durable subscription recovery
in bounded controls. The nullable `DateTime64` failure was isolated to a direct
HTTP date-before-NULL insert on ClickHouse 26.9.19.9. The latest stable
26.10.2.103 passed that minimal regression and the full bounded timestamp
pipeline, including non-UTC input and microsecond precision; production was
not upgraded. An actual WAL-loss fixture made source readiness return 503, but
controlled recovery is not yet qualified. The complete candidate allocation
also exceeds physical RAM before OS reserve. See the
[follow-up results](pulsar-cdc-assessment.md#follow-up-qualification-debezium-server--pulsar--seatunnel--clickhouse)
for the exact failures, protocol configuration, counts and limits. The CDC
retirement gate remains failed; the temporal gate's success on the qualified
candidate does not replace whole-host, application compatibility or erasure
qualification.

## 2026-11-04: ClickHouse merge-buffer attribution and isolated candidate

The bounded sink's warm 768 MiB/one-CPU qualification process repeatedly rejected
small journal queries at the server-wide memory limit. A 04:24:00 UTC victim
read nine rows and tracked about 1 MiB, which did not identify the global holder.
Idle cache-byte gauges totalled 439,999 bytes; idle allocator fragmentation and
persisted system-log size were different measurements and did not establish
allocation ownership.

One diagnostic startup enabled native global allocation sampling and
failure-triggered heap dumps on the same image, volume and cap. It reproduced
the failure and retained six native heap files. The exact heap-flush message,
table UUID and part log tied the first dump to a six-part horizontal Wide merge
of `system.query_log`, with 11,755 rows read and a 418,400,858-byte tracked peak.
Simultaneous file-write and compression buffers dominated the sampled merge
allocations. These buffers are constructed per output substream, rather than
once per SQL column. See the released [Wide writer](https://github.com/ClickHouse/ClickHouse/blob/c6428ebcc39fdff48bb0f50e128b2078701901d5/src/Storages/MergeTree/MergeTreeDataPartWriterWide.cpp)
and [stream-buffer constructor](https://github.com/ClickHouse/ClickHouse/blob/c6428ebcc39fdff48bb0f50e128b2078701901d5/src/Storages/MergeTree/MergeTreeWriterStream.cpp).
The diagnostic profiler was then removed and effective profiling/dump/stack
settings verified zero; this restart was for attribution, not a qualification pass.

A matched experiment used native [table clones](https://clickhouse.com/blog/table-cloning)
of 36,048 local log rows in four identical parts. Only the disposable source
fixture was held immutable; both measured targets and the real log table kept
their merges enabled. Each target received one explicit operator `OPTIMIZE FINAL`
to exercise the Wide writer. These were controlled fixtures, not natural-load
or production operations.

| Native allocation setting | Merge result | Tracked peak |
| --- | --- | --- |
| Default activation threshold 500 | Code 241 rejection | 381,446,352 bytes |
| Activation threshold 1 | Completed in 148 ms | 109,104,537 bytes |

The adaptive case kept the default 16 KiB initial and 1 MiB maximum buffers,
container cap, CPU, image and data unchanged. Record count and identity digest
matched before/after; this was not a complete payload-column checksum. All
disposable clones were removed. Native [adaptive buffer growth](https://github.com/ClickHouse/ClickHouse/blob/c6428ebcc39fdff48bb0f50e128b2078701901d5/src/IO/BufferWithOwnMemory.h)
reduces eager allocation for sparse streams but can still grow to the original
maximum. It is not a whole-query or whole-host memory bound.

The isolated candidate now sets only `system.query_log`'s activation threshold
to one. Journal 21/21 and core recovery 10/10 subsequently passed without a
restart or increased limits. Broader host fit, sustained throughput, natural
merge overlap, physical storage enforcement and production deployment remain
unqualified. No production setting or safety hold changed.

Durable configuration requires special care: the released [SystemLog builder](https://github.com/ClickHouse/ClickHouse/blob/c6428ebcc39fdff48bb0f50e128b2078701901d5/src/Interpreters/SystemLog.cpp)
accepts a per-log `settings` string, but a mismatched existing CREATE definition
causes table rotation rather than in-place settings migration. The renamed
TTL-bearing table retains its old merge settings. For the retained fixture,
the expected setting order is `index_granularity = 8192,
min_columns_to_activate_adaptive_write_buffer = 1`; formatted AST order is
significant to that comparison. Existing-table ALTER plus matching configuration,
same-UUID/history preservation across initialization and fresh canonical log
delivery passed on the retained isolated fixture, with no new rotated table.
Fresh-table creation, wider rotated-table inventory and production migration
remain unqualified. This is evidence for
26.10.2.103, not permission to add unsupported settings to production 26.6.

## 2026-11-04: Durable sink request-cost checkpoint

A finite local measurement submitted forty fresh synthetic scalar deliveries in
two sequential twenty-record API calls through the actual
[sink](../src/metric-stream/clickhouse-sink.ts) and
[delivery coordinator](../src/analytics/analytics-delivery.ts). It completed in
14,968 ms with forty visible current rows. Delegating client wrappers preserved
the owner's query IDs and counted 1,400 ClickHouse requests: 1,200 queries,
forty commands and 160 inserts. Setup and final verification were outside that
request count. The local adaptive query-log candidate described above remained
active; no resource ceiling, deadline or retry changed.

This confirms substantial per-delivery request cost. It measures neither native
Pulsar receive/ACK throughput nor PostgreSQL statement count, concurrent streams,
latency percentiles or complete host fit. The events used synthetic Kafka fixture
positions; this is not a native transport qualification. The unchanged
1,001-source provider-deletion case separately exceeded its existing 30-second
deadline and remains open. Thirteen other provider-command engine cases and the
owner-preserving legacy profiling regression pass; the smaller cases do not
replace that large-case gate.

The next correctness check prevents a callback from swallowing an unknown
ClickHouse request outcome and replacing its persisted query identity with a
second request. Request-registration cost can then be reduced within the same
fail-closed ownership protocol and measured against the retained baseline.
Native acknowledgment, complete erasure, CDC mapping, old R2 conversion and
whole-server resource qualification remain release gates.
