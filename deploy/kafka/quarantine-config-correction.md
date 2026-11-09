# Quarantine configuration correction

**Proposal only. The fix request authorizes implementation and qualification,
not another production release or topic update.** Kafka remains the live broker;
tiered storage is a separate release. The [completed shared release](shared-release-execution.md)
records the live discrepancy and its original before/after metadata.

## Cause and durable fix

The old quarantine writer sends three entries to legacy `AlterConfigs` on every
connection. That API replaces the complete override set, clearing independently
configured segment and remote-storage settings. A read-modify-write replacement
would also risk lost concurrent updates; see [Kafka KIP-339](https://cwiki.apache.org/confluence/spaces/KAFKA/pages/87298616/KIP-339%2BCreate%2Ba%2Bnew%2BIncrementalAlterConfigs%2BAPI).

The [fixed writer](../../src/metric-stream/redpanda-quarantine.ts) keeps the
existing create-if-missing operation and uses the existing KafkaJS
[`DescribeConfigs`](https://kafka.js.org/docs/admin#describe-configs) API to verify
exactly `cleanup.policy=delete`, `retention.ms=604800000`, and
`retention.bytes=1073741824`. It refuses startup on drift, missing/null/duplicate
entries, a broker error, or an incomplete/wrong topic resource. It disconnects
the admin before starting the producer, including on validation failure.
The erasure capture/expiry paths reuse this same validator; their retention
contract and native/retained-Redpanda completion gates remain in place.

Segment size, compression and remote-storage settings stay operator-owned.
There is no new SDK, protocol implementation, CLI, environment variable or
configuration repair during application startup. Existing topics with a bad
required policy must be corrected explicitly before their consumer can start.

## Qualification

- On isolated pinned Kafka 4.4.0, the new regression initially failed four of
  five cases: connecting reset explicit 128 MiB segments to the default 1 GiB
  and cleared the explicit remote=false override; all three bad required
  policies were silently rewritten. The same five cases pass with the fix,
  including reconnect, unchanged operator overrides and missing-topic creation.
- The actual consumer/quarantine/erasure integration set passed nine tests on
  that broker. The focused unit set passed 66 tests. Focused quarantine mutation
  testing killed all 69 counted mutants, with the existing threshold unchanged;
  see the [primary Stryker output](../../docs/evidence/kafka-quarantine-config-fix-20261109/stryker.txt).
- The stock `kafka-configs.sh --alter --add-config` payload below was exercised
  on a disposable topic. Native metadata showed its original topic ID unchanged,
  segment size corrected from 1 GiB to 128 MiB, and the other selected policy
  unchanged. The actual fixed writer then connected and reconnected without
  changing the configuration. No production topic was touched.
- Root/server/web typechecks and full `pnpm lint` passed, including analytics
  SQL.
  The SQL phase initially hit Docker-disk ENOSPC; removing only this workspace's
  completed disposable DB/Redis containers (preserving named volumes) freed the
  needed space. The same SQL command then passed. Local Redpanda startup remains
  blocked by the shared VM's exhausted asynchronous-I/O capacity; that failure
  was not bypassed or called a pass. Native Kafka qualification succeeded; CI
  still supplies the normal Redpanda check.

The permanent integration test also runs against the repository's Redpanda CI
fixture. Redpanda ignores the Kafka-only remote-storage key, so its test compares
supported operator overrides; the Kafka run additionally checks the explicit
remote override. See [the pinned Redpanda create handler](https://github.com/redpanda-data/redpanda/blob/v26.1.12/src/v/kafka/server/handlers/create_topics.cc#L302-L320).

## Proposed execution order — requires release approval

1. Review/merge the focused fix and qualify its exact main image. Freeze the
   merge revision and immutable digest; do not reuse the deployed `6fe` image or
   the earlier `3350` review image. Use the existing stock web-release dispatcher
   with its normal gates; leave the disabled automatic-workflow setting alone.
   **Before dispatch**, read the current policy for all three quarantine topics:
   each must have `cleanup.policy=delete`, `retention.ms=604800000` and
   `retention.bytes=1073741824`, with complete topic identity/config evidence.
   The fixed sinks intentionally refuse startup on drift. If any required value
   differs or cannot be verified, stop and obtain approval for its correction
   before releasing; the later two-override update does not repair these values.
2. Complete that release before the topic correction. Verify the three
   ClickHouse sinks are running the fixed image and every old consumer task has
   exited. Verify the normal worker entrypoint and read-only Kafka/retained-RP
   mounts, all six cluster/topic-generation checkpoints, remote=false, consumer
   health/lag and the existing 20 GiB free-space reserve. Unexpected routes,
   identities, old running clients or missing prerequisites stop the operation.
   A config-only repair while old clients can reconnect is insufficient.
3. The approved correction would incrementally set only the two lost overrides
   on the existing three quarantine topics below. Retention byte/time values,
   cleanup policy, source topics, topic IDs, routes and offsets are not changed.
   Run operator JVMs outside the broker cgroup, using the existing Q4 command
   shape and pinned image. Each failed command must stop the outer operation.
   Immediately before applying it, take a fresh read of each topic's ID,
   selected config values and config sources, and compare it with the
   [recorded post-release audit](../../docs/evidence/kafka-shared-production-release-20261109/topic-policy-after-release.json).
   This procedure expects the recorded default 1 GiB segment size and default
   remote=false on each quarantine, plus the unchanged required policy. Any
   drift, including a newer operator segment override, stops this procedure
   pending a revised reviewed correction; do not overwrite it with this older
   proposal. One responsible release operator coordinates the topic-change
   window from this read through final verification, with no concurrent topic
   configuration edits. Kafka's incremental update is not a compare-and-set.

```bash
# Approved operator session on dofek-server, after the fixed release is verified.
for quarantine_topic in \
  metric-stream-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3.quarantine.v1 \
  metric-stream-live-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3.quarantine.v1 \
  metric-stream-history-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3.quarantine.v1; do
  if ! docker run --rm --network dofek_default --memory 384m \
    -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
    --entrypoint /opt/kafka/bin/kafka-configs.sh \
    apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
    --bootstrap-server kafka:9092 --entity-type topics \
    --entity-name "$quarantine_topic" --alter \
    --add-config segment.bytes=134217728,remote.storage.enable=false; then
    exit 1
  fi
done
```

This is the stock incremental update, not legacy full replacement; see
[Kafka's topic configuration procedure](https://kafka.apache.org/44/operations/basic-kafka-operations/).
It does not repartition/recreate topics or delete broker data.

4. Read back all six topic identities and selected settings through the existing
   metadata observer. Quarantines must retain delete/seven-day/1 GiB retention
   plus explicit 128 MiB segments and remote=false; sources retain their
   existing 4 GiB policy. Compare against the fresh pre-update snapshot and the
   coordinated approved delta: topic IDs and every unrelated setting must be
   unchanged. An unexpected newer setting is drift, not permission to accept the
   older proposal's value. Record consumer convergence, lag, archive errors and
   reserve. Any requested reconnect qualification belongs to this reviewed
   release operation; do not add an unapproved extra restart just to test it.
   The isolated connect/reconnect proof is already complete.
5. Preserve old Redpanda and aborted Kafka directories, the erasure completion
   hold and the already frozen stop/preserve/forward recovery plan. Kafka has
   application writes: there is no old-Redpanda cutback. Tiering, retirement,
   credentials, OCI and the separate erasure-scrub combination remain outside
   this correction.

## Retrospective

The regression reproduced the exact config-source and segment-size changes;
sharing the existing validator avoided a second policy implementation. Health
and zero lag alone did not detect configuration loss. Add the post-client
override comparison to future release reviews. Reproduce similar failures with
a failing test and verify the correction against the pinned broker, following
the [testing guide](../../docs/testing.md).
