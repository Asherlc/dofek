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

The subsequent ownership fix (`b86fe246c`) passed ten real-engine cases and
independent review: catching an unknown request outcome can neither replace the
first query identity nor return apparent success and clear its pending intent.
A separate attribution run observed 6,479 checked-out PostgreSQL client query
calls for forty deliveries, alongside the same 1,400 ClickHouse calls and forty
visible rows, in 13,881 ms. This is a second baseline observation, not evidence of
an optimization or a native throughput result. Request-registration reduction
remains under implementation and requires its own correctness review.

Provider command checkpoint `55ed6754d` also passed independent re-review.
Actual `FINAL` queries ignored a fully materialized alternate projection and
read all 65,536 unrelated ACK rows. Deterministic command slots for each deletion
root/predecessor now use the existing event-ID primary key; full immutable-body
hash and exact receipt checks remain. Twelve measured lookups read 8,192–8,194
rows with useful primary-key plans. Nineteen selected protocol engine cases and
207 focused unit tests passed. The original 1,001-source workload remains open;
necessary constructor-ID changes did not reduce its workload or deadline.

The legacy suite now uses the existing private current-schema fixture
(`89eb029a5`), resolving fixed-ID/new-account collisions with retained structural
history. Its independent review passed, and twelve cases passed before an
unchanged 350-delete case reached its 30-second deadline; two cases remained
unrun. Cooperative cleanup awaited operations before dropping the fixture, with
no post-drop query failure. Both large-case gates, native acknowledgment,
complete erasure, CDC mappings, R2 conversion and whole-server qualification
remain open.

## 2026-11-04: Bounded observation of legacy R2 archive shapes

Read-only source preparation was supplemented by LIST of twenty objects, HEAD
of five and conditional GET of those five small revisions. Only counts, schema
shapes and digests were recorded; payload values were neither printed nor
retained. The listing was truncated. The five objects contained respectively
1, 500, 1, 4 and 2 row-v1 lines: 508 records, all with IDs, without explicit
operation revision, generation, transport envelope or processing-membership
fields. Existing [v1 codec defaults](../src/metric-stream/events.ts) remain
defined semantics; an omitted field is not automatically lost required evidence.
No conversion, archive mutation, completeness verdict or claim that any actual
range is irrecoverable follows from this sample.

All five inspected headers exposed ETag and no VersionId. Three metadata maps
were empty; two contained archive endpoints and Kafka fields. The pinned
[line-archive implementation](https://github.com/redpanda-data/benthos/blob/v4.76.0/internal/impl/pure/processor_archive.go#L137)
retains the first member's metadata, and the pinned
[S3 writer](https://github.com/redpanda-data/connect/blob/v4.99.0/internal/impl/aws/s3/output.go#L378)
copies selected metadata into object headers. These are object-level fields,
not per-line positions. The actual historical writer version remains unobserved.
[Erasure rewrites](../src/account-erasure/archive-erasure.ts) can remove lines
while preserving those headers, so a header offset cannot automatically identify
the current first line. Task 9 still requires complete inventory, exact provenance
and explicit resolution of overlap, deletion and ordering evidence; neither key
endpoints nor line ordinals manufacture missing Kafka offsets.

## 2026-11-04: Bounded journal reads pass the original 1,001-source gate

Checkpoint `8848d6e84` batches the existing three journal proof queries over
each existing page of at most twenty identities, then fetches exact payloads
for a reference page together. Full storage identity, per-key ambiguity and
missing-evidence checks, reference order and all later phase observations
remain. Public append inputs preflight every chunk before any write. Independent
review approved both scoped requirements and code quality, with only inherited
test-output noise deferred. See the [journal implementation](../src/analytics/effect-journal.ts)
and its [real-engine regressions](../src/analytics/effect-journal.integration.test.ts).

The driving tests observed sixty proof reads versus three and twenty payload
reads versus one before the fix, then the expected bounded counts afterward.
Eighty-one distinct engine cases passed across separate invocations; this is not
one combined 81-case run. Sixteen native query profiles read 51–13,941 rows
against 40,000-history fixtures, with useful primary-key plans. Those physical
read counts are granule work, not twenty physical rows or a whole-host bound.

Root then ran the unchanged
`structural1001SourceContinuationAndTwentyEffectWrites` case once with retry
zero and bail one. It passed: the reported case duration was 26,761 ms, suite
duration 27.51 seconds, with 1,779 observed HTTP requests and zero HTTP errors.
The original 30-second deadline, 1,000-plus-one command split, 1,001 raw rows,
and twenty-effect write maximum were retained. Assertions verified all 1,001
effects, exact page/tail/terminal receipts and zero remaining live raw rows.
Cleanup awaited the actual operations and finished in 465 ms, without a
post-drop query failure. This closes that functional/performance gate for this
fixture; it does not establish native broker throughput or sustained capacity.

ClickHouse retained the same image, 768 MiB cap, warm process and local
query-log buffer candidate. PostgreSQL used the separately recorded isolated
1 GiB fixture budget. Earlier latency baselines used different PostgreSQL
resources, so this result is not a controlled elapsed-time comparison. The
350-message deletion gate remains open: most of its deliveries have no effects,
and the batched loops save no calls for those deliveries. Native ACK, raw-input
query-log privacy, writer/erasure barriers, full CDC mapping, archive conversion
and whole-server qualification remain release gates. No production setting,
deployment or safety hold changed.

The subsequent legacy sink invocation passed fourteen cases in 54.14 seconds,
excluding only the unchanged 350-message case. This includes the two cases
previously left unrun after that timeout. The exclusion retains an explicit
open gate; it is not a full fifteen-case suite pass.

## 2026-11-04: Raw input separates values from SQL; all-log erasure remains open

Reviewed source `e320e1758` sends raw metric fields through the official client's
separate request body, using `input()` and a fresh JSONEachRow stream per row.
The canonical client privately uses its existing SDK's `exec` capability; no
dependency, alternate HTTP client or production transport was added. Input
commands force synchronous inserts, end-of-query buffering and disabled progress
headers, consume the response fully and require empty output. Unexpected
nonempty success output, truncation and lost responses preserve uncertain query
ownership rather than publishing success. See the [client adapter](../src/db/clickhouse.ts),
[source writer](../src/metric-stream/source-effects.ts),
[official SDK API](https://github.com/ClickHouse/clickhouse-js/blob/client-1.23.1/packages/client-common/src/client.ts)
and [HTTP response caveats](https://clickhouse.com/docs/interfaces/http#http-response-codes-caveats).

An attempted whole-row input changed generation lookup into a correlated
subquery. Its first form silently inserted zero rows with no generation record;
explicit coalescing restored that semantic but the native plan aggregated the
whole generation table, reading 20,002 rows against 20,000 unrelated records.
That candidate was rejected. User/provider alone remain constant SQL bindings,
preserving the bounded lookup and insert-time account/generation predicates.
All remaining raw fields are separate input data. Exact field equivalence,
nullable/Float32 values, timestamps, versions, opaque metadata, empty/current/
stale generations and erased live/tombstone rows passed real-engine checks.
This is limited query-text privacy: account/provider identities remain visible.

The final combined owner/input/HTTP/recovery run passed 45/45 in 30.74 seconds;
35 focused units and static checks also passed. Independent review initially
found that the stream-failure fixture rejected before the SDK returned a
response. Test fix `8e2827104` causally observes the real SDK's fulfilled HTTP
200 response before inducing body failure, then requires drain-time
`ECONNRESET`/`aborted`, distinct from unexpected nonempty output. Original query
identity, pending intent, blocked continuation and blocked replacements remain
asserted. Scoped re-review approved the fix with no new findings. These are
finite correctness checks, not sustained throughput or host qualification.

Malformed input still exposed its synthetic marker in the retained server
exception and default SDK logger, despite absence from query text. The specific
diagnostic emits counts/booleans; ordinary expected SDK exception text remains
in synthetic test logs. One original diagnostic was overwritten before hashing;
its lost provenance is explicitly unresolved, while later independent evidence
corroborates the finding. Fix-round originals and hashes are retained. No live
personal data was used or queried.

Complete log erasure is therefore still a release blocker. The current eraser's
application-database inventory excludes native system logs; SDK errors also
have local Docker and configured processor routes. Current query-owner state
retains only its latest query ID, not an account history. Task 7 must qualify
actual account attribution, writer/logging cutoffs, retained log generations,
physical removal or verified expiry and processor copies. Query-string privacy
and a retention setting alone do not prove those properties. See the
[erasure implementation](../src/account-erasure/clickhouse-erasure.ts),
[error routing](../src/lib/error-reporting.ts),
[collector configuration](../deploy/otel-collector-config.yaml),
[native query-log schema](https://clickhouse.com/docs/operations/system-tables/query_log)
and [text-log schema](https://clickhouse.com/docs/operations/system-tables/text_log).
No logs were disabled, retention changed, production deployment performed or
safety hold restored. Native ACK, the 350-message gate, CDC, archive conversion
and resource/erasure qualification remain incomplete.

One subsequent forty-delivery measurement completed with forty visible rows in
13,490 ms and the same 1,400 ClickHouse requests (1,200 queries, forty commands,
160 inserts) and 3,679 PostgreSQL client query calls. These one-effect deliveries
receive no benefit from the earlier page amortization; the new input path adds
no request. Broker receive/ACK and concurrent streams are excluded. Earlier
elapsed baselines used different PostgreSQL resources, so this is request-count
attribution, not a controlled latency-improvement claim.

## 2026-11-04: Exact successor ownership and cooperative receipt completion

Reviewed `7e15af803` reduces request-related PostgreSQL exchanges from 2N to N+1
for N > 0 within one query-owner lifetime. Exact predecessor identity and locally known
terminal execution authorize successor registration; every ClickHouse query and
data-proof observation remains. Final terminal persistence precedes outer owner
success/quiescence on both callback success and known-terminal failure. This
intentionally leaves a longer conservative nonterminal window after executor
loss, requiring the approved positive external recovery proof. Actual killed
executors, late writes, lost registration/final proof and closing were covered.
The [owner contract](../src/analytics/README.md) documents that boundary.

Qualification also found a pre-existing cooperative progress bug: A's receipt
and frontier could commit before a final transport check failed. Receipt replay
then verified A but retained its pending intent, blocking B. The desired-B-success
regression failed on both old and candidate source. Reviewed fix `aa6a05e44`
tightens the existing receipt callback into a required canonical completion
verifier and retires only the exact matching completed intent after fresh proof
and terminal finalization. Unrelated B and its ingestion time survive A replay;
unknown owners remain blocked. No new recovery mode, state store or raw-data
mutation capability was added.

One final invocation passed 146 real-engine cases across seven files in 77.07
seconds, including thirty coordinator and forty-five owner cases. Thirty-two
focused units, types, scoped Biome and diff checks passed. Independent review
approved the named fix, with all twenty-one evidence hashes matching. Earlier
fixture mistakes and one redundant failed attempt are retained, not counted as
independent passes. No full repository or native-broker result follows.

A post-review forty-delivery measurement completed in 11,996 ms with forty rows
visible, unchanged 1,400 ClickHouse requests and 2,319 PostgreSQL client calls,
versus 3,679 PostgreSQL calls in the preceding same-budget observation. That is
1,360 fewer measured client calls. One elapsed pair is not sustained-throughput
or latency-regression proof. The original 350-message gate still reached its
unchanged 30-second deadline: 3,369 observed HTTP requests, zero HTTP errors,
476 ms cooperative cleanup and no post-drop failure or resource fatal. The warm
ClickHouse/PostgreSQL processes and caps were unchanged. Do not retry to green
or increase its deadline.

The bounded logged subset for that failed run includes 1,110 manifest SELECTs,
806 journal SELECTs and 320 reference SELECTs, each with maxima of 32, 30 and
38 ms respectively. This confirms continuing serial metadata-request cost;
the aggregation includes fixture setup/cleanup and excludes unlogged requests,
PostgreSQL and client time. It does not establish a completed-delivery count or
prove every millisecond's owner. Performance, native ACK, physical enforcement,
erasure, CDC and archive gates remain open; all production holds remain.

## 2026-11-04: Shared-ledger erasure conflict blocks cutover

Released-source qualification identifies a conflict in the proposed shared
legacy/live/history topic layout. A durable subscription requiring account B's
unprocessed records can indefinitely retain a ledger also containing erased A.
Managed-ledger trimming is gated by the slowest required cursor before retention
is applied. Native offload deletion removes whole data/index objects, without
an account predicate. Thus this required failure case cannot preserve B while
certifying A's physical removal within the existing day-29/day-30 policy. See
[Pulsar 5.0.1 trimming](https://github.com/apache/pulsar/blob/v5.0.1/managed-ledger/src/main/java/org/apache/bookkeeper/mledger/impl/ManagedLedgerImpl.java),
[the released offloader](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java)
and [the application erasure policy](account-erasure-runbook.md).

Pulsar 5.0.1 pins BookKeeper 4.18.2 in its
[version catalog](https://github.com/apache/pulsar/blob/v5.0.1/gradle/libs.versions.toml).
Its published [4.18.2 sources](https://repo.maven.apache.org/maven2/org/apache/bookkeeper/bookkeeper-server/4.18.2/bookkeeper-server-4.18.2-sources.jar)
distinguish metadata deletion from journal/entry-log byte reclamation. Size-based
rotation, retained backup journals, active entry-log exclusion and compaction
eligibility also prevent treating default scheduling intervals as a low-write
physical-expiry bound. Broker timed ledger sealing is a different mechanism;
it does not prove those bookie files disappeared. Effective runtime settings
and every retained generation still need executable qualification.

Healthy finite-drain cleanup is unqualified, not proved impossible. The
indefinitely retained required-subscription counterexample is the specific
blocker; it is not a claim that every Pulsar layout is unsuitable. Source review
alone does not certify an actual running distribution's deletion behavior.
Native fixtures must separately inspect mixed-account backlog, metadata-gone/
bytes-present behavior, low-write offload/cleanup and quarantine/matched restore.
Local files, native R2 data/index/orphan uploads, attributable metadata and new
component backups all require proof. TTL, ledger-list absence or a successful
trigger-GC response alone cannot certify completion.

Q10 requests approval to assess account-isolated Pulsar streams with bounded
native cleanup, retaining the existing server and erasure deadline. No alternative
layout commands or code have been executed, no policy weakened and no production change
made. Cutover remains blocked. Independent transport-neutral analytics
correctness work may continue while that layout decision is pending.

## 2026-11-04: Existing raw locator passes a finite twenty-ID prerequisite

An isolated real-engine probe used the current [raw schema](../src/metric-stream/clickhouse-table.ts)
and [structural history/MV](../src/db/analytics-work-schema.ts), without a new index
or payload copy. On 400,000 rows in ten parts, twenty scattered source IDs included
ten NULL and ten linked activities. Literal and structural-subquery scopes returned
identical complete raw payloads. The guarded lookup resolved global identity and
the exact `(source_version, ingested_at)` before eligibility filtering, then rejected
missing payloads, cross-account UUID ownership, conflicting payloads and ambiguous
placement. A missing-newer-payload control retained one older raw row and still
failed explicitly rather than selecting it.

The final guarded query finished in 117 ms with 5,296,361 bytes peak under the
unchanged 134,217,728-byte query allowance. Its 819,300 total reads comprise
163,840 raw rows, four structural traversals and scope reads; this is material
granule/read amplification, not twenty point reads. Native plans selected existing
indexes/projections without forced optimizer settings. The disjoint NULL/non-NULL
lookup follows [ClickHouse IN semantics](https://clickhouse.com/docs/reference/statements/in#null-processing);
[native projections](https://clickhouse.com/docs/data-modeling/projections) and
[MergeTree indexes](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/mergetree)
explain the retained neighboring-granule work. No additional index was justified
for this supplied-ID fixture.

Independent review approved this finite prerequisite, verified all seventeen
artifact hashes and independently reconstructed the complete semantic fixture
digest. An initial probe JSON-number precision error was preserved and corrected
with explicit lossless SQL strings before accepting payload evidence. An existing
private DELETE initially waited behind the fixture's stopped merges; resuming
only that private table settled the original request, after which merges were
stopped again. All 163 requests settled and the private fixture was synchronously
dropped. No resource failure, deadline increase, retry or server restart occurred.

The field-domain boundary is explicit: raw version is Int64, structural version
UInt64, raw recorded time DateTime64(6), and structural recorded time DateTime64(9).
The fixture proves above-2^53 values within raw Int64 and nanosecond ingestion
ties, not full-UInt64 raw versions or nanosecond recorded-time storage. Complete
affected-key candidate discovery, missing-candidate detection, historical/index
bootstrap, merge/replay retention, publication ordering and the actual bounded
models remain unqualified. In particular, [ReplacingMergeTree](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replacingmergetree)
does not use ingestion time as a secondary equal-version replacement key.
This lookup proof cannot establish those separate obligations, native ACK,
physical erasure or cutover. Production and all four safety holds were unchanged.

## 2026-11-04: Complete key membership and native structural index qualified narrowly

A separate actual-schema/MV fixture discovered all 35 historical source IDs,
including 28 at one key, prior memberships of a twice-moved UUID and both original
HR/RR channels for normalized heart-rate scope. An unchanged candidate absent
from the page remained discoverable after its entire raw payload was removed;
raw-only discovery lost it. The opposite raw-present/structure-absent control
also failed explicitly through the complete candidate union. Missing-from-both
coverage still requires protected historical inventory.

Existing ID-leading structure read about 200,000 unrelated rows for these keys.
One native four-field projection over `(user_id,channel,recorded_at,source_id)`
was materialized only in the private fixture. Materialization alone did not help:
both ordered and unordered DISTINCT retained an in-order base read. The
[released eligibility guard](https://github.com/ClickHouse/ClickHouse/blob/v26.10.2.103-stable/src/Processors/QueryPlan/Optimizations/projectionsCommon.cpp#L46-L79)
excludes that mode before [normal projection selection](https://github.com/ClickHouse/ClickHouse/blob/v26.10.2.103-stable/src/Processors/QueryPlan/Optimizations/optimizeUseNormalProjection.cpp#L390-L406).
Matched unordered GROUP BY returned the identical complete membership set and
naturally selected one of 49 projection granules: 6,787 reads including four
scope rows, versus 400,003 for either DISTINCT form. No setting forced selection.

The actual guarded query retained projection access, global revision lookup and
raw/structural consistency checks. It read 66,989 rows, peaked at 6,500,881 bytes
and rejected the deliberately missing structural owner. That first error masks
the simultaneously missing raw payload; it is not a successful complete-payload
qualification of the new form. Canonical model tests must establish that positive
path and isolated negatives independently. All 156 requests settled and the private
database was synchronously removed. Independent review matched 29 artifact hashes
and approved this finite prerequisite, not the actual new macro or full Task 3.

The initial fixture exceeded its 400,000-total-row ceiling by 39 semantic rows;
those extra unrelated rows were removed before the corrected baseline. Preserved
UNION typing and assertion-order mistakes were corrected without hiding them.
All historical semantic memberships survived the explicit private merge. The
projection added 4,159,764 disk bytes; observed materialization/merge/mutation
peaks reached 109,274,490 bytes, distinct from foreground query memory. Production
bootstrap, insertion overhead, physical erasure and complete host fit remain open.
No canonical index or production deployment was performed by this qualification.
