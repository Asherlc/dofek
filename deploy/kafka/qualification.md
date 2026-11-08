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
