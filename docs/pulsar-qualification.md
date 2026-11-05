# Single-server Pulsar qualification — 2026-11-03

**Decision: blocked before application migration or production deployment.**
The isolated topology works on ARM64. A narrow source correction to the bundled
offloader now passes actual Cloudflare R2 upload and readback; stock drivers
still fail. The proposed whole-host memory budget does not fit the current
service ceilings. This is evidence for Task 1 of the
[approved plan](superpowers/plans/2026-11-03-single-server-pulsar.md), not a
production certification or a completed resync. No production producer, sink,
retention, filesystem feature, or resource limit was changed.

## November 4 retention decision and remaining risk gates

The [approved broker-expiry policy](account-erasure-runbook.md#approved-broker-expiry-policy-for-the-pulsar-migration)
allows unread broker data to expire when necessary to meet account erasure,
after an alert and operator incident. Lost ranges remain incomplete until
verified recovery; historical reconstruction is not guaranteed. The 30-day
deletion deadline remains unchanged. Shared topics are the selected layout
under that policy, conditional on qualification of expiry, offload and physical
cleanup; account isolation is no longer required to preserve indefinitely
stalled backlog. No production setting has been changed.

The native BookKeeper replacement result below remains a primitive qualification.
It does not qualify the broker's full deletion lifecycle or failed-delete
reconciliation. Exact source attribution for failed-delete cleanup remains
unqualified; further upstream provenance investigation has stopped. The planned
native lifecycle fixture must exercise a real failed deletion, safe orphan
attribution and physical removal. An unattributed ledger must never be deleted
on the basis of absence alone. These are open gates, not evidence that the
mechanism is impossible. Pulsar's verified release commit is
[`9ef1a62af60850cfae91c386e8d3bf84aa401a5c`](https://github.com/apache/pulsar/tree/9ef1a62af60850cfae91c386e8d3bf84aa401a5c);
its [dependency catalog](https://github.com/apache/pulsar/blob/9ef1a62af60850cfae91c386e8d3bf84aa401a5c/gradle/libs.versions.toml#L29)
pins BookKeeper 4.18.2. Unverified web excerpts are insufficient for storage
invariants.

One workstation-only R2 metadata census reached its fixed limit of 100 LIST
pages: 100,000 objects totaling 19,945,268,349 compressed bytes. It did not reach
the end of the namespace. Origin classification remains unknown, and the eight
syntactic overlap components are not proven Kafka coverage. No payload was read
or modified by that census, and it does not qualify full conversion or snapshot
consistency.

A separate conditional read of three objects in one actual overlap component
examined 489,891 compressed bytes and 10,208 version-1 rows. It found 8,208 unique
IDs: 6,208 occurred once and 2,000 were exact duplicates, with no conflicting
payloads. Those rows lacked explicit operation revisions and original ingestion
times. Order is harmless for this component because duplicate payloads match;
this does not qualify the remaining archive. Conversion must check each component
and block conflicting identities rather than invent offsets. Originals remain
untouched, and a complete inventory is still required.

### Storage prerequisite remains unresolved

The November 4, 22:00 UTC read-only production snapshot found 9,732,775,936 bytes
(9.064 GiB) free on the data filesystem, below the unchanged 15 GiB admission
guard. Public health and service replicas were healthy. Analytics, Ride with GPS
and Strava queues remained paused with no active jobs; the history ClickHouse
sink remained at zero replicas. No hold was restored.

Active canonical CDC destinations occupied 277,913,171 bytes across 134,207
physical rows, excluding 252,425,693 bytes of internal PeerDB tables. Active
analytics occupied 9,322,944,772 bytes, including 637,658,688 bytes in dbt staging
tables. These are measured current footprints, not bounds for replacement
generations, compression or future history growth. No staging cleanup credit
has been assumed. Migration must account concurrently for hot Pulsar storage,
the evacuation copy, replacement CDC and analytics tables, conversion staging,
ClickHouse growth and temporary merges, WAL, and reserve.

Retiring the retained Redpanda history data is not currently justified by the
archive evidence. The truncated census contains no observed history-topic
objects; that does not establish their absence from R2. Zero archive lag and
filename range unions do not establish present coverage of every retained
record: the [archive configuration](../deploy/redpanda/metric-stream-r2-archive.connect.yml)
groups by timestamp hour and writes payload lines with endpoint metadata, while
[account erasure](../src/account-erasure/archive-erasure.ts) can replace an object
under the same key after removing records. Historical writer/acknowledgement,
object-preservation and erasure lineage remain unproved. No topic has been
trimmed or retired. This does not prove a larger disk is required. Pulsar's
[tiered storage](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/)
offloads sealed broker ledgers and permits reads from remote storage; it does
not relocate ClickHouse tables or automatically retire existing Redpanda data.
The remaining gate is a safe transition sequence with a bounded local footprint
and verified release of old storage. The approved expansion is a fallback,
currently blocked on OCI access and canonical Terraform state, rather than an
established prerequisite. The subsequently authorized manual offload below is
the selected capacity assessment; further archive-provenance investigation has
not begun.

### November 5 native lifecycle qualification: setup remains unqualified

The isolated runs have not yet exercised expiry, R2 deletion and evacuation
end to end. Bootstrap, policies, the mixed A/B ledger, healthy acknowledgements
and the stalled-subscription age metric were observed. All attempt-owned
services stopped successfully; production settings, holds, existing volumes and
original archives were preserved.

Two setup defects were confirmed and corrected: the bare metrics route returned
HTTP 301 with an empty body, and the runtime-configuration CLI printed text
rather than JSON. The fixture now uses the trailing-slash metrics route and the
native JSON REST configuration endpoint. See the pinned
[metrics context registration](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-broker/src/main/java/org/apache/pulsar/broker/PulsarService.java#L1290)
and [CLI map printer](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-client-tools/src/main/java/org/apache/pulsar/admin/cli/CliCommand.java#L106).
A preflight-only rehearsal passed without seeding or claiming lifecycle success.

The subsequent full run stopped with
`STOP: observed-age-alert-and-incident observation budget exhausted`.
All 36 HTTP observations succeeded, but the metric first appeared at seed plus
64.145 seconds with age two, rising to 45 at seed plus 106.966 seconds. The
fixture's 100-second window was inconsistent with native behavior: the
[non-precise age check uses the closed ledger's timestamp](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-broker/src/main/java/org/apache/pulsar/broker/service/persistent/PersistentTopic.java#L4661),
which is [assigned when the ledger closes](https://github.com/apache/pulsar/blob/v5.0.1/managed-ledger/src/main/java/org/apache/bookkeeper/mledger/impl/ManagedLedgerImpl.java#L2335).
The retained broker log records L1 closing at seed plus 61.252 seconds. This
explains the observed age; response caching is not the diagnosis.

One corrected run is authorized with a 145-second alert observation budget:
63 seconds for rollover including jitter, 60 seconds of reported age, ten for
refresh, ten for HTTP and two for polling. The full survivor timeline must still
meet the existing remaining-TTL guard before evacuation. B is scheduled at
seed plus 540 seconds with TTL 600 seconds. Recovery admission requires at least
420 seconds of B's TTL left, so it must begin by approximately seed plus 720;
the existing 300-second recovery bound then leaves 120 seconds of B's TTL and
60 seconds within the 18-minute outer limit. Actual deletion must be observed,
and a late phase fails the guard. A setup failure parks the fixture; a failure
of preservation or deletion criteria requires a user decision. The lifecycle
remains unqualified until those criteria pass.

The corrected run passed the alert at reported age 61, observed L1's R2 data
and index objects, and published B2 on schedule. It then stopped at an
instantaneous fixture assertion: `currentLedgerEntries === 1` returned zero.
Retained native stats show the actual B2 ledger, 8, contained one entry and was
already offloaded; ledger 17 was the empty current ledger. The fixture had
incorrectly assumed the survivor must still occupy the open ledger. This is a
fixture failure, not evidence of data loss or a native lifecycle failure.
Owned-service cleanup passed. No further run is authorized: the fixture is
parked pending an assertion review and a user decision. TTL expiry, R2 deletion,
evacuation and final verification remain unqualified together.

For production, this non-precise alert understates message age by up to the
rollover interval, proposed as four hours plus jitter. The day-seven alert
budget must include that lag. The fixture must observe expiry independently;
the age metric does not establish the timestamp used by TTL.

The proposed timing model is operational budgets plus day-29 verification and a
supported operator action, rather than guaranteed completion from polling
intervals. These are targets for an active erasure, not deployed policies:

| Stage | Proposed production target | Isolated fixture |
| --- | --- | --- |
| Fence and healthy drain | Fence at day 0; target drain within one day | A write cutoff is a prerequisite; application integration excluded |
| Ledger rollover and offload | Four-hour rollover plus native jitter; offload sealed ledgers at threshold zero | One-minute rollover; threshold zero |
| Local offload deletion | Zero lag proposed | Ten-minute lag preserves B's native bytes as a positive control |
| Stalled backlog | Alert by day 7; expiry around day 14 when needed for the deletion deadline | Observed age at least 60 seconds; TTL 600 seconds |
| Retention and R2 cleanup | One-day retention; verify actual object removal | One-minute retention; ten-second eligibility checks |
| Bookie cleanup | GC followed by evacuation in the day 20–25 window | Existing 300-second evacuation bound |
| Verification | Day 29, retaining the day-30 deadline | Eighteen-minute observation bound after seeding |

The [pinned managed-ledger implementation](https://github.com/apache/pulsar/blob/v5.0.1/managed-ledger/src/main/java/org/apache/bookkeeper/mledger/impl/ManagedLedgerImpl.java)
and [broker configuration](https://github.com/apache/pulsar/blob/v5.0.1/conf/broker.conf)
provide scheduling controls, not hard completion guarantees. Production drain
and realistic-copy evacuation durations remain inputs to the whole-host gate.
The fixture uses uncompressed synthetic markers; production physical checks
must rely on complete ledger/object inventories when payloads are compressed.
Failed-delete orphan cleanup remains the separately recorded residual risk.

### November 5 source-neutral CDC transaction admission

The pure transaction gate now admits already validated records only when the
END record, all transaction ordinals and all per-table counts agree. It retains
original native delivery evidence, collapses source republication to one source
revision, and rejects conflicting payloads, delivery reuse and lineage changes.
Missing END or ordinal evidence remains pending. Streaming revisions use the
adopted UInt128 encoding within one admitted generation and lineage.

Nineteen unit cases pass against retained synthetic native captures, including
the primary-key split in transaction 820, reversed allocation/commit order in
825/826 and 25 actual republications. Independent review found no critical or
important issue; root TypeScript, formatting and spelling checks pass. See the
[gate](../src/analytics/cdc-admission.ts) and its
[tests](../src/analytics/cdc-admission.test.ts).

This qualifies transaction accounting, not the seven production table decoders.
The captures use qualification tables rather than the fitness schema. Native
position validation, bounded durable pending storage, ownership resolution,
raw writes, receipts, frontiers and acknowledgements remain caller obligations
for the following CDC slices. The gate is not activated and must not ship before
its production caller and those handoffs are implemented.

### November 5 legacy archive metadata inventory

A bounded, read-only LIST reached EOF after 400 pages: 399,547 objects and
56,803,150,041 listed bytes. All observed keys passed the existing archive-key
parser. Private output used 248,975,878 bytes within its 256 MiB limit; the run
also retained the 1,000-page, ten-second request and fifteen-minute overall
limits, with one request attempt. It issued no HEAD, GET or object mutations.
The inventory digest is
`ba97b598595dd980e7946f62cc5b518b2fd635d5852071891cd45577ad371061`.

This completes the metadata census only. Source origins remain unknown, and a
single listing does not prove immutable object revisions or conversion
correctness. Filename ranges do not establish that event identities are
isolated between overlap components. The converter must settle cross-component
identity conflicts before claiming safe publication; no per-event registry or
new storage mechanism has been adopted.

### November 4 manual offload: verified method, bulk copy in progress

**November 5, 00:35 UTC update:** the consumed prefix is complete. All 345
objects, covering `[21,161,777, 55,609,019)` and exactly 34,447,242 records,
passed the final audit and current-ETag checks. Their 18,001,078,232 original
payload bytes occupy 1,381,320,745 compressed bytes. Structural proof manifests
are published remotely. A second guarded stock trim advanced the broker start
to the unchanged ClickHouse consumer position, `55,609,019`; the high watermark
remains `74,445,631`. Free space increased from 30,105,157,632 to
33,039,454,208 bytes in that operation. Public health and all four holds passed.
The unread 18,836,612-record tail is now being copied with the same proofs and
no automatic trim. Its local copy remains until the archive audit and the
R2-to-Pulsar recovery route are qualified. Copy completion does not mean the
history has been ingested or the migration is ready for cutover.

At 01:26 UTC, that unread-tail copy completed all 189 ranges: 18,836,612 records,
8,025,553,104 payload bytes and 574,486,983 compressed bytes. Every range passed
independent raw-byte read-back, second broker read, contiguity and the deployed
erasure-parser dry run. The final current-object audit passed and published its
proof manifests. Together with the consumed prefix, 534 objects cover exactly
53,283,854 records across the entire frozen retained range. A fresh source check
confirmed unchanged consumer positions and high watermark, healthy public service
and 33,005,129,728 free bytes. The local unread copy remains because the
replay-route gate is still open.

**November 5, 00:09 UTC update:** 296 objects covering exactly 29,600,000
records in `[21,161,777, 50,761,777)` passed all checks below. The final audit
confirmed current object ETags and published the structural proof manifests.
Payload comparisons used original value bytes, before parsing, on both the
independent R2 read-back and the second broker read. Stock `rpk topic trim-prefix`
then advanced the history partition start to `50,761,777`. The high watermark
remained `74,445,631`, the ClickHouse consumer remained at `55,609,019`, and the
archive consumer remained at that high watermark. Free space immediately rose
from 8,132,595,712 to 26,983,030,784 bytes, a measured gain of 18,850,435,072
bytes. Public health passed. All four production holds remain in place;
available capacity does not qualify Pulsar or authorize fresh ingestion.

The following chunk stopped before upload at offset `50,806,573`: its valid
event used the existing publisher's `activity:<activityId>` key, which the
one-time exporter's classifier had omitted. Exact matching and mismatched-key
controls now cover the correction; no record was skipped. The publisher's
[key rule](../src/metric-stream/events.ts) and
[replacement tests](../src/metric-stream/redpanda-producer.test.ts) identify this as an
operator classification defect rather than invalid source data. Continuation
starts explicitly at the last verified chunk boundary, `50,761,777`, retaining
the failed partial file as evidence. The unread 18,836,612-record tail remains
local and must receive the same proofs before its local copy is retired.
Measured bulk verification was about 5,580 records/second, projecting roughly
71 minutes for the remaining consumed prefix and unread tail together, excluding
final audits and any further stops. This is an operator-copy observation, not
Pulsar ingestion throughput. Complete migration overlap and lifecycle gates
remain open.

The user authorized manual R2 offload to qualify migration on the existing disk.
Fresh broker inspection found one history partition with retained offsets
`[21,161,777, 74,445,631)`, a ClickHouse consumer position of `55,609,019`, and
30,938,607,616 bytes in its local history directory. The first target is the
already-consumed prefix, ending at that consumer position. The unread tail is
retained. The topic uses seven-day retention; observed record timestamps at the
retained start and unread-tail start were November 2 and November 3 respectively.
These observations are not a complete segment-expiry proof.

The first 100,000 records were uploaded without overwriting an existing object.
Their 52,195,417 payload bytes compressed to 4,168,391 bytes. A full independent
R2 download matched the compressed and payload hashes; a second broker read
matched the exact record-tuple and payload hashes. All offsets were contiguous,
all values passed the deployed strict event schema, and a complete dry run of
the deployed archive-erasure parser passed without writes. Topic bounds, leader
epoch and partition-directory identity remained unchanged. No local records
were deleted for this qualification.

The bulk operator copy now applies those checks in ranges of at most 100,000
records, using only a bounded workstation spool. Every range checks public
health, production disk space and the frozen topic identity before continuing.
It stops on the first failure and performs no automatic record deletion.
Completed ranges retain independent read-back and erasure-parser receipts.
Only a contiguous verified prefix may later be reclaimed, after confirming the
remote object revisions still match and recording fresh broker boundaries and
consumer positions. Redpanda's stock
[`trim-prefix` operation](https://docs.redpanda.com/streaming/current/reference/rpk/rpk-topic/rpk-topic-trim-prefix/)
is the proposed reclaim mechanism; broker files must never be unlinked manually.

This is an application event-log archive, not a broker image. Original event
bytes, revisions and order are preserved in the existing gzip JSONL format, which
the [production archive writer](../deploy/redpanda/metric-stream-r2-archive.connect.yml)
already uses without Kafka keys and timestamps. Structural manifests retain
offsets, counts, hashes and hashed processing-key runs for verification before
erasure; raw processing keys are not stored there. The original processing
context remains in marker event payloads. Kafka key, timestamp and offset
restoration is not promised. Account erasure may rewrite objects, so conversion
must use the content-identity checks above rather than infer original offsets
from line numbers or depend on stale manifest hashes. All four production holds
remain in place; neither bulk offload nor migration capacity is yet qualified.

## Acceptance results

### Parallel archive-reader checkpoint

The [streaming reader](../src/metric-stream/archive-reader.ts) now validates
legacy gzip JSONL while preserving original payload bytes, revisions, controls
and physical line ordinals. It enforces explicit compressed, decompressed and
line bounds, checks the observed ETag and sealed compressed digest, and owns
stream cleanup. Yields remain provisional until successful EOF; neither a line
ordinal nor a filename endpoint is a recovered Kafka offset.

Independent review found a mutable-input ownership issue. Two reproductions
failed before the fix; the reader now snapshots its source, identity and bounds.
All 68 focused reader/schema/key cases pass. A local dry run over the retained
independent R2 download of 100,000 manual-offload records reached verified EOF
and matched the payload digest, publishing nothing. The full unit/mobile tier
passed 24,700 tests, with 19 skipped; root/server/web types and dependency
analysis also pass. Earlier stale client, migration-list and obsolete SQL-shape
test expectations were repaired without changing production behavior.

The publisher contracts have also moved out of the Kafka implementation without
changing its factory or runtime selection. The concrete Pulsar sender, component
planner, transfer ledger, real broker/offload proof and complete archive inventory
remain open. This checkpoint is not a completed converter or permission to
replay production data.

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
| Native BookKeeper evacuation and old-storage retirement | PASS, bounded ARM fixture | One 135.687-second case validates surviving ledgers, erased-marker exclusion, replacement crash/restart and exclusive old-file retirement; excludes full-pipeline erasure and production fit. |
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

## 2026-11-04: Account isolation does not bound local journal erasure

The user reaffirmed Pulsar on the existing server as the project goal and accepts
held production ingestion while it is qualified. An independent direction review
prioritized erasure viability and aggregate host fit before further framework
work. The following is a finite source assessment, not an adopted topic layout,
runtime experiment or cutover approval.

Account-isolated topics can give an account independent ledger ownership, but
BookKeeper still shares local journal and entry-log files. In the exact
[BookKeeper 4.18.2 source artifact](https://repo.maven.apache.org/maven2/org/apache/bookkeeper/bookkeeper-server/4.18.2/bookkeeper-server-4.18.2-sources.jar),
`Journal.run` rolls when flushed bytes exceed the journal size limit and blocks
when no entries are queued. `Journal.checkpointComplete` deletes only journal IDs
strictly older than the checkpoint's journal and retains the configured backup
generations. This version is pinned by the
[Pulsar 5.0.1 version catalog](https://github.com/apache/pulsar/blob/v5.0.1/gradle/libs.versions.toml).

Consequently, after deleting account A's independently owned ledgers, an idle
current journal can still retain A's bytes while account B's ledgers remain
valid. Reducing a byte threshold does not bound elapsed time without more writes.
The inspected public configuration and administrative API provide no journal-age
rollover or selective current-journal cleanup mechanism. This blocks certifying
the existing [day-29 verification/day-30 completion contract](account-erasure-runbook.md)
from passive native expiry alone; it does not establish that every Pulsar
deployment or maintenance mechanism is unsuitable.

The same source accepts scheduled `majorCompactionThreshold=1.0`, allowing native
compaction of eligible partially-live entry logs while retaining foreign live
ledgers. Thus the default 0.5 threshold is tunable, not a fundamental limit.
That control does not solve current-journal or current-entry-log eligibility.
No setting was changed and no confirming fixture was started.

A supported bookie evacuation/replacement procedure is a proposed assessment,
not a selected remedy. It would need to preserve foreign backlog and durability,
remove every relevant old local file, meet the existing deadline, and fit the
temporary copy plus memory overhead on this server. Those capabilities and costs
remain unqualified. No filler traffic, disabled journaling/backups, restart loop,
custom storage-engine rewrite or weaker erasure policy is assumed.

The source pass ended at this decisive missing mechanism. The useful lesson is
to separate broker-ledger eligibility from physical journal reclamation and to
resolve that release gate before building dependent integration. Production,
existing jobs and archives, and all four safety holds remain unchanged.


## 2026-11-04: Native evacuation remains unqualified after fixture bootstrap failures

A minimal native regression now covers the proposed replacement procedure in
`src/metric-stream/bookie-evacuation.pulsar.integration.test.ts`, with one required
ARM CI job. It checks erased-account marker absence, complete surviving-ledger
hashes and ensemble membership, old-bookie-offline writes, replacement restart
and exclusive old-storage retirement. These are test assertions, **not passed
qualification results**. Neither CI attempt reached bookie creation.

The [first ARM attempt](https://github.com/Asherlc/dofek/actions/runs/41859366383)
failed while formatting fresh metadata: Oxia returned `server not initialized
yet` until the existing 60-second command bound. The fixture had omitted the
native data-server registration and namespace creation already described in the
[metadata bootstrap procedure](../deploy/pulsar/README.md). The
[released data-server](https://github.com/oxia-db/oxia/blob/v0.18.0/cmd/admin/dataserver/create/cmd.go)
and [namespace admin commands](https://github.com/oxia-db/oxia/blob/v0.18.0/cmd/admin/namespace/create/cmd.go)
were added with independent configuration and shard-assignment assertions; no
limits, retries or erasure criteria changed.

The [final corrected attempt](https://github.com/Asherlc/dofek/actions/runs/41861291852)
failed earlier, at data-server registration, with `rpc error: code = Unavailable
desc = oxia: server not initialized yet`. Captured coordinator logs showed
`Waiting to become leader` and no leader-ready event before cleanup. That
establishes an unmet readiness prerequisite at the call, but does not establish
whether the coordinator would eventually become ready. Both artifacts preserve
the exact commands, first errors, native logs and phase; no unchanged rerun or
longer timeout was used. Further native attempts stopped at the two-attempt
infrastructure limit, pending direction on a reviewed readiness-gated fixture.

The native evacuation mechanism has therefore neither passed nor failed its
behavioral criteria. Production temporary-copy capacity, aggregate memory,
Pulsar current-ledger succession, cursor/offload compatibility and complete
physical erasure remain separate open gates. Existing jobs, R2 originals and all
four production holds remain unchanged. The superseded first branch CI run was
explicitly canceled after its completed native failure evidence was retained;
no production workflow was canceled. Other branch CI failures remain unresolved
release gates and are not represented as a successful full check run.

The useful correction is to include the adjacent component's fresh bootstrap
procedure in the fixture, and distinguish process startup, coordinator readiness,
configuration persistence and shard assignment. This fixture has not justified
any production cutover or weaker erasure policy.


## 2026-11-04: Leader readiness passes; native client setup still blocks evacuation

The user approved one additional readiness-gated attempt after reviewing the two
bootstrap failures. The [approved ARM run](https://github.com/Asherlc/dofek/actions/runs/41863160374)
used commit `acd26afd3` and retained the existing 60-second observation and
300-second case bounds, memory caps, quorum and erasure assertions. Its read-only
leader check observed the known not-initialized state, then succeeded. Native
data-server registration, namespace creation, metadata formatting and exact
single-shard RF1 assignment passed. The source bookie's native HTTP state was
running, writable and not shutting down.

The first standalone Java client invocation then failed in phase `initial`:
`java.lang.IllegalArgumentException: Unknown backend metadata-store`, from
`MetadataDrivers.getClientDriver` before the client could create any ledger.
This proves a client initialization failure; missing metadata-driver registration
is an inference, not a source-confirmed root cause. No A/B entries, recovery,
replacement restart, marker exclusion or old-storage retirement were exercised.
**Native evacuation remains unqualified; its behavioral criteria have neither
passed nor failed.** The partial metadata/bootstrap result applies to this pinned
fixture and does not qualify production capacity or the complete pipeline.

The run's log and 69 synthetic evidence files were retained with SHA-256 hashes.
No fourth attempt, fixture fix, deadline increase or alternative mechanism was
started. The monitor stopped after collecting the failed native step. Any future
attempt requires explicit direction after a source-confirmed client setup fix,
with client create/read capability checked before the A/B recovery sequence.
All production holds and original archives remain unchanged. Independent bounded
analytics work continues; full erasure, memory, temporary-copy disk and legacy
conversion gates remain open.

The useful lesson is to qualify the official client initialization path before
building recovery assertions on it. Future fixture briefs should name that
precondition alongside coordinator readiness and namespace assignment.


Source comparison with the [stock Pulsar 5.0.1 launcher](https://github.com/apache/pulsar/blob/v5.0.1/bin/bookkeeper#L262-L264)
subsequently confirmed the standalone client's missing
`bookkeeper.metadata.client.drivers` JVM property; the exact pinned JAR already
contains the official driver. The fixture now uses that stock property and a
closed-ledger create/full-read/delete preflight before A/B recovery. Independent
source review and exact-JAR offline compilation passed; native execution remains
pending GitHub Actions recovery. No dependency, cap, deadline, quorum or erasure
criterion changed, and no runtime success is claimed for the correction.


## 2026-11-04: Native evacuation primitive passes in ARM CI

The [approved native job](https://github.com/Asherlc/dofek/actions/runs/41871869660/job/126721886208)
passed on `ubuntu-24.04-arm` at commit `10735959f`, completing at 16:57:24 UTC.
The single case took **135.687 seconds**, under its unchanged 300-second limit,
with retry zero, quorum 1, two 768 MiB bookies, two 128 MiB Oxia processes and a
separate 512 MiB client. The source-confirmed driver correction and closed-ledger
create/read/delete preflight executed before the recovery workload.

The [checked-in fixture](https://github.com/Asherlc/dofek/blob/10735959fa4bac8547f56d9cac4ce483b3f46460/src/metric-stream/bookie-evacuation.pulsar.integration.test.ts)
asserted all surviving B entry counts and full payload hashes, every surviving
ledger's ensemble excluding the old bookie, source-readable manual-read-only
recovery, old-offline readback and new writes, replacement SIGKILL/restart
readback, B-marker presence and A-marker absence across replacement journals and
entry logs, and removal of exclusively owned old native storage. Source marker
presence was the positive scan control. All assertions and success cleanup passed.

Independent review reconciled the exact commit, source hashes, ARM job, retry-zero
command and successful result. The retained job log has SHA-256
`a17a8157fdd806d5c84ee94795082afe7a8c335be749771455406159afcb330a`.
Successful per-phase manifests/native files were intentionally removed by the
test cleanup; the evidence is the immutable tested source plus successful
non-skipping assertions, not a separately retained per-phase forensic capture.
The reported duration covers the entire fixture, not a production evacuation
throughput measurement. Whole CI success is not claimed.

This qualifies the native local-file replacement primitive only. Pulsar broker
current-ledger succession and cursors, offloaded-only data, R2/legacy conversion,
metadata/backups, actual day-29/day-30 enforcement, complete CDC/ClickHouse
behavior, and production aggregate memory/temporary-copy disk remain open gates.
The replacement becomes the sole persistent bookie; production must retain enough
space for the old files and the complete required replacement copy concurrently.
No production service, hold, data, resource ceiling or erasure requirement changed.

The milestone closes a concrete native mechanism question. The next work remains
the minimal bounded query and then the complete host/storage envelope; this pass
does not authorize a production cutover or weaken any remaining gate.

## 2026-11-04: Sensor semantics and original memory gate pass; larger gates remain open

The [validated-page compiler checkpoint](https://github.com/Asherlc/dofek/commit/ab6ec3a6a)
passed the seven named sensor semantic cases and the missing/stale/ambiguous-input
controls through actual PostgreSQL capture, native dbt compilation and ClickHouse.
The original resource fixture contained 800,000 normalized versions, matching raw
history, 400,000 source IDs and 1,000 keys. One 20-reference page matched all 8,000
scalar and 20 deduplicated stable rows. Observed query peaks were 67,159,715 and
100,813,112 bytes, below the unchanged 134,217,728-byte allowance. The pathological
single-key page failed with its own code 241, wrote no target rows and left the
same healthy server process running. Actual executor cursor/CAS behavior remains
unproven until Task 5's `pathologicalPageMemoryFailureDoesNotCheckpoint` case.

Adding four times the unrelated neighboring history preserved the exact affected
page. Scalar still matched its complete output, but read 66,619,703 rows versus
25,003,575 originally. Raw/normalized held parts also increased from 80 to 320,
so that ratio alone does not establish an absent index predicate. Dedup then
failed at the local server-wide memory boundary, despite an observed query peak
of 91,184,127 bytes. A separate plan-input attempt also stopped during loading
at that global boundary, before EXPLAIN. Neither attempt qualifies pruning or
the complete larger workload. ClickHouse distinguishes global and query memory
tracking; see its [memory-overcommit documentation](https://clickhouse.com/docs/concepts/features/configuration/settings/memory-overcommit).
The allocation owner beyond the recorded global/RSS failure is unresolved; no
OOM kill or container restart was observed.

Further local Task 3 runtime is stopped. The next qualification is one ARM CI
EXPLAIN-only run with a discriminating recorded layout and the same per-query
budget, alongside a complete production memory/temporary-copy assessment. No
query rewrite is selected without an identified unprunable read leg. Production
fit, analytics drain throughput, larger dedup execution and cutover remain open.
At 18:55 UTC the three operation-owned queues remained paused and idle, and the
history ClickHouse sink remained at zero replicas; no hold was restored.

A read-only production check found 23,974.86 MiB physical RAM and 9,744,707,584
available data-disk bytes. The favorable retained-PeerDB steady ceiling total is
still 24,568 MiB before Redis, host reserve and other omitted costs: the existing
allocation fails. Historical resident-memory queries separately measured
2,371.781 MiB during the held November 4 window and 4,625.582 MiB during the
November 3 history-drain window after analytics became idle. The latter has
47,111 samples over 03:35:00–16:40:10 UTC, query ID
`whole-host-drain-memory-20261103-033500-164011`. These are resident samples,
not cgroup ceilings or permission to lower the 13 GiB production allocation.
Adding a serialized 128 MiB page leaves non-resident costs, consumer increment,
host/uncapped-service reserve and intake-rate equivalence unqualified. The full
surviving-ledger replacement copy, conversion overlap and erasure deadline also
remain unqualified. No service limit, capture topology or hold changed.

The useful distinction is fixture loading/verification versus measured model
execution, and query-owned failure versus aggregate server pressure. Preserve
those phases and the physical part layout when reviewing future resource results.
