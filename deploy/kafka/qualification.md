# Kafka protocol qualification — November 8, 2026

This record qualifies bounded protocol paths, not production activation or
remote physical erasure. No production service, offset, topic, secret or archive
was modified. Image observations are in [the packet](cutover-packet.md).

| Check | Observed result | Limit |
|---|---|---|
| PR #3233 at `2fe0ab29e` | 86 successful, 24 skipped, one neutral; none pending or failed | Not cutover evidence |
| Existing real-engine tests | Two files, four tests passed on stock Kafka 4.4.0 | Remote storage disabled |
| Deployed image `b5676e56…` | Actual producer/consumer factories preserved live/history event IDs and scalar payloads using `REDPANDA_BROKERS` | No full service boot or ClickHouse persistence test |
| Repaired history image `d8ca75d1…` | Actual producer/consumer factories preserved live/history event IDs and scalar payloads using `KAFKA_BROKERS` | Production role is history consumption; no full ClickHouse sink test |
| Connect image `0e1fb0a8…` | Three archive groups consumed two records each; original grouping/archive/gzip pipeline preserved all six JSON records in order; every group committed offset `2` | Local file output replaced S3; no R2 delivery claim |

The repaired history image uses `src/metric-stream/kafka-consumer.ts`; the older
application uses `src/metric-stream/redpanda-consumer.ts`. Preserve their actual
different environment contracts during cutover. Do not introduce fallback
variables into application code. The ordinary branch-built image continues to
use its own source contract.

## Local method and reproducibility

The isolated Compose project was `kafka-broker-migration-kafkaqualification`,
started and stopped through `pnpm compose -- --project-suffix kafkaqualification`.
It used the candidate's pinned stock Kafka digest, single-node KRaft, RF1,
1 GiB heap and 2 GiB container limit. Separate internal/host listeners served
container/host clients. No client JVM ran inside the broker cgroup.

Docker initially ran out of writable space before broker formatting completed.
Cache cleanup reclaimed zero bytes. The disposable protocol fixture used a
256 MiB tmpfs log directory and one offsets-topic partition. These are local
test settings, not proposed production settings or tiered-storage qualification.

```sh
REDPANDA_BROKERS=127.0.0.1:39092 pnpm exec vitest run --project integration \
  src/metric-stream/redpanda-consumer.integration.test.ts \
  src/account-erasure/redpanda-drain.integration.test.ts
```

Each deployed image ran locally with its entrypoint overridden to Node, without
starting HTTP. Temporary TypeScript fixtures imported the image's own publisher
and consumer factories, created isolated topics/groups, published synthetic
scalar events and asserted IDs/payloads after consumption. Fixture corrections:
the older image needs `externalId` when no explicit ID is supplied; the repaired
image rejects explicit row IDs and derives one from `externalId`. No production
code changed for testing.

Connect used the checked-in pipeline with `http.enabled: false`, synthetic
legacy/live/history topics and local file output. Each gzip file was decompressed
and compared against both seeded records; KafkaJS admin inspection asserted
committed offset `2` for each group. This does not replace an R2 write test.

All four owned containers and the isolated Compose network were stopped and
removed. Other workspaces' running containers and named database volumes were
untouched. The old application image was removed locally after its smoke test
to recover disk space; production images were unchanged.

## Activation gap

The deployed worker's replay-expiry check compares low offsets; it does not
inspect remote deletion completion. The frozen
[R2 deletion experiment](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-r2-q-mpudel-20261107b/README.md)
explicitly reports partial deletion evidence. A stopped, retained Redpanda tree
also cannot perform retention cleanup. The
[Kafka remote deletion design](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage)
does not make offset advancement a physical deletion receipt.

Protocol compatibility is supported; unchanged-worker erasure compatibility is
not established. A narrow safety release and retirement procedure need an agreed
design before activation. The unrelated snapshot/catalog/identifier redesign
does not by itself close this gap.

## Coordinated ownership

The account-erasure agent confirmed at PR #3234 commit `d48352b3c` that its
[`assertAccountErasureReplayExpired`](https://github.com/Asherlc/dofek/blob/d48352b3c/src/account-erasure/redpanda-drain.ts)
still compares offsets and its quarantine verifier delegates to the same check.
The [runtime callers](https://github.com/Asherlc/dofek/blob/d48352b3c/src/jobs/account-erasure-runtime.ts)
and [retention phase](https://github.com/Asherlc/dofek/blob/d48352b3c/src/jobs/account-erasure-phase-runner.ts)
do not verify broker remote objects or retained Redpanda files. Its ClickHouse
physical-erasure work does not provide either broker safeguard.

Kafka PR #3233 is the single owner of these two safeguards. The erasure branch
will preserve a small explicit runtime/retention dependency when combining the
changes; it will not implement a duplicate helper. No broader snapshot, catalog,
identifier, checkpoint or writer-race redesign transfers to this branch.
The intended retention call uses the existing ingest-fence and quarantine
checkpoints; the scrubbed representation retains only topic, partition, low and
offset. No implementation is claimed by this ownership agreement.

The stock proof boundary remains unresolved. Aiven's
[key factory](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java)
encodes topic UUID, partition and segment start offset. R2 supports strongly
consistent [object listing](https://developers.cloudflare.com/r2/reference/consistency/)
and [multipart listing](https://developers.cloudflare.com/r2/api/s3/api/).
But listing absence does not establish that an admitted copy cannot later
recreate an object. Kafka's
[remote-log manager](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java)
advances the log start offset before initiating remote deletion; it separately
tracks copy-in-progress and deletion lifecycle states. A safe success path must
establish the terminal deletion/generation boundary as well as physical absence.
Neither agent will label an offset, log message, or bare listing a substitute.

## Bounded stock-capability review: activation remains blocked

The November 8 source review reached the following conclusion; this is not a
claim that a zombie upload was reproduced in production or an R2 experiment.

- Kafka 4.4's [remote-log manager](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java)
  registers copy-start metadata before calling the storage plugin and copy-finish
  metadata afterward. Its cleaner skips an in-process copy known to that manager.
  It advances log start offsets before deleting remote segments, publishes
  delete-start before the plugin call and delete-finish only after it returns.
- Kafka exposes segment state through the Java
  [topic-based metadata manager](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/metadata/storage/TopicBasedRemoteLogMetadataManager.java).
  The stock [metadata formatter test](https://github.com/apache/kafka/blob/4.4.0/storage/src/test/java/org/apache/kafka/server/log/remote/metadata/storage/RemoteLogMetadataFormatterTest.java)
  demonstrates decoding `__remote_log_metadata` with
  `RemoteLogMetadataSerde.RemoteLogMetadataFormatter`. The
  [live cache](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/metadata/storage/RemoteLogMetadataCache.java)
  removes terminally deleted segments, so an empty live list is not a complete
  historical record of copy admissions and completed deletions.
- Aiven 1.2's [storage manager](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/KafkaRemoteStorageManager.java)
  uploads log, indexes and manifest; error cleanup of orphan objects is best
  effort. Its [S3 backend](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3Storage.java)
  checks per-object deletion errors. Its
  [upload stream](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3UploadOutputStream.java)
  performs synchronous single PUT or multipart completion/abort. These calls
  contain no Kafka leader-epoch condition that fences an admitted storage write.
- Kafka task cancellation sets a cancellation flag and interrupts its future;
  the inspected manager does not obtain an object-store acknowledgement that
  every previously admitted write has been fenced. Consequently, cancellation,
  broker restart, or a new leader's delete-finish state does not by itself prove
  that an old admitted storage operation cannot later recreate an object. This
  is a missing success guarantee in the inspected path, not a demonstrated
  production failure. Multipart listing also does not enumerate single PUTs.
- Topic UUID is necessary structural checkpoint data for identifying a recreated
  topic correctly. It could extend the existing checkpoint JSON without a new
  receipt/store. However, the deployed
  [KafkaJS metadata implementation](https://github.com/tulios/kafkajs/blob/v2.2.4/src/protocol/requests/metadata/index.js)
  supports versions 0–6, before topic UUID metadata. A UUID-capable stock client
  or stock Kafka tooling would be needed; capturing UUID still does not supply
  the missing storage-write fence.

Thus terminal segment metadata plus complete object/multipart listings can
describe observed deletion, but the inspected stock interfaces do not establish
the required admitted-copy/generation fence for lasting physical absence under
crash/restart. Untracked/orphan objects require actual namespace inspection too;
metadata state alone cannot exclude them. No bare-listing success path, manual
certificate, feature flag or custom coordinator has been implemented.

The one smallest alternative proposed for user strategy alignment is stock Kafka
as a hot log **without tiered storage**, retaining the existing JSONL archive
and implementing the retired-Redpanda completion hold. This changes the approved
storage strategy and has not been implemented. It does not waive local broker
file erasure, archive erasure, capacity qualification or separate production
retirement approval.
