# Hot-log-only Kafka qualification

Status: **offline investigation; production activation remains blocked**.
Following the stock tiered-storage proof gap in [qualification.md](qualification.md),
the user's November 8 “continue” was treated as approval to qualify the proposed
hot-log-only alternative. The separately approved narrow worker safety release
is included. Neither approval authorizes deployment, retirement of production
data or a cloud experiment. After qualification, the offline review candidate
explicitly promotes hot-log mode into the canonical base stack; no mode overlay
or toggle is required by normal deployment.

## Observed local storage lifecycle

An isolated stock Kafka 4.4.0 broker used pinned image
`apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f`,
a 2 GiB container limit and a 256 MiB RAM filesystem for logs. Its generated broker
properties explicitly reported `remote.log.storage.system.enable=false`.
No RSM plugin, object-store credential or production service was involved.

Two batches of 100 synthetic records created segments starting at offsets 0 and
100. Stock Kafka `DeleteRecords` advanced the partition's low offset to 100:

| Observation | Low offset | Old segment 0 | Newer segment 100 |
|---|---:|---:|---:|
| Before logical expiry | 0 | 814,387 B | 814,387 B |
| Immediately after logical expiry | 100 | 814,387 B still present | 814,387 B |
| Physical cleanup observed at 16:51:57 UTC | 100 | Log and index files absent | 814,387 B |

The initial publication/expiry observation began at 16:48:20 UTC. Old bytes were
observed absent about 217 seconds later. This directly demonstrates that the
existing offset-only erasure check can return before local files are removed,
even with tiered storage disabled. It does not demonstrate a production failure.

The broker kept the stock five-minute
[`log.retention.check.interval.ms`](https://kafka.apache.org/44/configuration/broker-configs/)
and one-minute
[`file.delete.delay.ms`](https://kafka.apache.org/44/configuration/topic-configs/).
An initial 90-second harness observation was shorter than those settings and
failed its premature cleanup assertion. Follow-up observation continued through
the same broker's unchanged cleanup cycle; no production or test broker delay
was reduced to manufacture success. A topic fixture also initially used a 1 KiB
segment, below Kafka 4.4's documented 1 MiB minimum, and was corrected to that
minimum. BusyBox file inspection used supported `find`/`stat` commands.

Only synthetic local topic records were deleted. No archive or historical
account-data scan was performed. The owned qualification Compose project was
removed with the workspace wrapper and `down --remove-orphans --volumes`.

## What this establishes and what remains

Existing deployed-image protocol checks already ran with remote storage disabled;
those unchanged results remain in [qualification.md](qualification.md). This
additional fixture isolates logical expiry versus physical local deletion. It
is not a durability benchmark, a full-service boot, a disk-capacity qualification,
or a complete worker erasure implementation.

A hot-log-only release requires:

- The narrow worker check of physical local storage below covers retained/deleting
  segment files and topic generations, rather than a sleep after offset expiry.
  Unknown/missing storage evidence blocks completion. Its qualified scope is the
  pinned native lifecycle described below.
- The previously approved retained-Redpanda completion hold and a separately
  approved retirement procedure. A stopped broker does not perform retention.
- Continued JSONL archive erasure and archive-key collision protection. The
  durable JSONL archive is not a transparent Kafka remote-segment fetch path;
  recovery outside broker retention needs the existing explicit archive replay.
- A local disk budget and operational margin. At the previously proposed one
  partition and 1 GiB per source/quarantine topic, six topics imply a 6 GiB
  configured retention target, before segment overshoot, delayed deletion,
  indexes and broker metadata. This arithmetic is not a hard disk ceiling or
  a measured retention window under production ingest.

The tradeoff is removal of the unresolved live remote-copy fencing problem in
exchange for more local disk use and bounded broker replay.

## Narrow worker safeguard

[`KafkaLogStorage`](../../src/account-erasure/kafka-log-storage.ts) is called by
the actual worker's final retention phase. It checks the active broker's metadata
and configuration: one broker/controller, one in-sync replica and partition per
topic, exactly the mounted log directory, and remote storage disabled. Missing,
malformed, unsupported or mismatched evidence blocks completion.

The adapter binds captured offsets to native cluster/node metadata and the
`partition.metadata` topic UUID before and after capture. Cluster/topic IDs remain
structural fields in the existing checkpoint JSON. The PII scrub projects only
topic, partition, low/next offsets and these UUIDs, bounded to three source and
three quarantine boundaries. It strips other fields, including fields inside
each array entry. Old checkpoints without generation evidence fail closed;
the release must finish old-generation requests before cutover rather than
infer missing identity or rewrite a completed boundary.

Final retention checks all six configured topics. Any old log, index, snapshot,
deleted/cleaned/swap file, extra partition, future/deleting/stray replica directory,
unknown related file or symlink blocks success. Native metadata and generation
are checked again after inspection. The worker never reads record payloads.

The worker also mounts the existing canonical `/mnt/dofek-data/redpanda` root
read-only. **Any entry or read error blocks completion.** This uses the original
tree in place; there is no new empty staging directory, move operation, flag or
manual acknowledgement that could bypass the hold. Redpanda must be stopped and
the original root preserved until separately approved retirement. Do not move
the old tree outside this watched root.

### Scope of the native proof

Kafka's pinned [LocalLog deletion path](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/LocalLog.java)
renames segment files with a deletion suffix and schedules native deletion.
[`LogSegment`](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/LogSegment.java)
deletes its log and indexes.
[`FileRecords`](https://github.com/apache/kafka/blob/4.4.0/clients/src/main/java/org/apache/kafka/common/record/internal/FileRecords.java)
closes the shared channel before unlinking; slices share that channel.
[`AbstractIndex`](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/AbstractIndex.java)
closes/unmaps before deletion. Kafka suppresses channel-close exceptions, so the
Linux/JDK scope matters: the [OpenJDK close path](https://github.com/openjdk/jdk/blob/jdk-25%2B36/src/java.base/share/classes/sun/nio/ch/FileChannelImpl.java)
waits for registered channel operations before closing the descriptor, and
[Linux close](https://man7.org/linux/man-pages/man2/close.2.html) releases the
descriptor even when reporting ordinary close errors. This is native broker
filesystem lifecycle removal, not forensic overwrite, RAM/cache erasure,
arbitrary external file-handle inspection or a guarantee about copied backups.
Existing archive, backup and processor erasure gates remain independent.

### Actual adapter qualification

The [synthetic receipt](native-storage-proof.json) records the production adapter
rejecting old files immediately after logical expiry. A stock broker restart
preserved the checkpoint's topic UUID; a fresh worker-style admin still observed
retained bytes. The adapter accepted only after native cleanup removed them.
No cleanup interval, deletion delay or production timeout was changed. The
reported 7,829 ms is the final resumed observation interval, not total retention.

The initial restart harness tried to reconnect the same explicitly disconnected
KafkaJS admin object and failed with `write after end`. It was replaced with a
fresh worker-style admin while continuing the same broker and checkpoint. This
was a fixture correction, not a production retry layer. A temporary Compose
network also required an explicit unused subnet because Docker's default pools
were exhausted; other workspaces' resources were not pruned.

Focused filesystem, phase, runtime and broker-renderer tests passed (82 tests).
The configured `pnpm test --maxWorkers=2` run passed 23,788 tests across 1,457
files before the final cluster-ID-only renderer simplification and additional
negative storage fixtures; the affected focused tests were rerun afterward.
The Postgres
regression first failed because the old scrub discarded generation evidence;
its 13-test suite passed after bounded structural projection. The two existing
request-to-completion/crash-recovery integration tests also passed after their
fixtures supplied real ingest/drain checkpoint shapes.

## Workstation prerequisite

The first local broker launch failed before JVM startup with
`mkdir: cannot create directory '/opt/kafka/bin/../logs': No space left on device`.
Docker reported no rebuildable build cache. Stock unused-image cleanup reclaimed
2.239 GB under the standing cleanup authorization, including unused qualification
images; no running container or database volume was removed. The same broker
then started without retry/timeout configuration changes. This local prerequisite
failure is separate from the logical/physical expiry observation above.

## Packaged worker phase qualification

The [pinned-image receipt](worker-image-proof.json) records source
`cd9c4eb28d186a2fab9af2ac2e91864c32f38477` executing the packaged
`retention_verification` phase and `KafkaLogStorage` against six synthetic source
and quarantine topics. The phase rejected logical-only expiry, retained topic
generations across broker restart with a fresh client, and accepted only after
stock native cleanup (78,208 ms observed after restart, not the complete retention
interval). A retained Redpanda entry then blocked the same phase. The broker
cleanup settings were unchanged and the worker's matching storage mounts were
read-only. Production Node flags and telemetry preloads were used.

This qualifies the broker guard through the production phase, with unrelated
archive/backup/processor gates supplied by fixture stand-ins; it does not claim a
complete queue-driven worker boot or qualify those independent gates. The
instrumentation emitted `TimeoutNegativeWarning`; assertions completed without a
runtime workaround. The owned fixture container/network were removed. No
production state was changed. See the [review build](https://github.com/Asherlc/dofek/actions/runs/42506782417)
for artifact provenance and the [native lifecycle sources](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/LocalLog.java)
for the cleanup implementation.

Follow-up review checks passed: 56 native-storage tests, 25 drain/schema tests,
three runtime-wiring tests, mobile typecheck, root typecheck and 13 real Postgres
scrub tests. Focused stock Stryker runs scored 100% for the runtime constructor
and checkpoint-schema ranges (14 killed), and 83.92% for the complete native
adapter (240 killed, 39 survived, seven uncovered). The latter clears the existing
75% gate; it does not establish complete mutation coverage. No thresholds or
exclusions changed. The only subsequent production-source change narrows the
factory environment's TypeScript input type; it changes no executable logic in
the pinned image. CI must still settle on the pushed review head.
