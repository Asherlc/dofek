# Broker-only cutover qualification packet

Status: **not executable or approved for activation**. This packet is prepared
for review; the stop gates below must be closed before adding final mutation
commands and requesting a maintenance window. Do not reuse the aborted combined
release packet. See [the aborted attempt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-cutover-attempt-20261108/README.md).

## Pinned application contract

Read-only Swarm inspection on November 8, 2026 confirmed these service images:

| Services | Immutable image |
|---|---|
| web, worker, legacy and live ClickHouse sinks | `ghcr.io/asherlc/dofek@sha256:b5676e5616082a09184397f0ea328b28e9d1320c4124cbafaf4f0578899e2d84` |
| history ClickHouse sink | `ghcr.io/asherlc/dofek@sha256:d8ca75d14b4da18057f3cf43d34889adf3d65c4927caccee69a8cee34e8120a1` |
| all three R2 archives | `docker.redpanda.com/redpandadata/connect:4.99.0@sha256:0e1fb0a8c14d8752e3bb56a317ebe0867bdb61873fe2bb3cfcb64f9139589989` |

The old application and Connect use `REDPANDA_BROKERS`. The repaired history
image already requires `KAFKA_BROKERS`; preserve that service's existing key.
Actual-image protocol checks and their limits are recorded in
[qualification.md](qualification.md).

Refresh this observation immediately before proposing maintenance. Capture
service task templates privately, including replicas, environment, Swarm config
IDs, network IDs and image digests; do not publish environment values. Docker
documents [service inspection](https://docs.docker.com/reference/cli/docker/service/inspect/).
No application image, migration journal, ClickHouse version or PeerDB mirror
change belongs in this operation.

## Stop gates

1. **Remote physical erasure:** current worker replay verification uses the
   broker low offset. The frozen R2 delete experiment explicitly reports only
   partial proof, not remote deletion completion. No physical-erasure guarantee
   follows from offsets or an about-to-delete log. See the
   [existing experiment](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-r2-q-mpudel-20261107b/README.md)
   and [Kafka remote deletion design](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage).
2. **Retired broker bytes:** stopping Redpanda also stops its retention work.
   Retaining its tree for rollback does not establish physical erasure. Agree
   the erasure-completion hold and separately authorized retirement boundary
   before pausing production. Do not delete the old tree under cutover approval.
3. **Archive identity:** the retained Connect config writes keys containing
   topic, partition, UTC date/hour and first/last offsets. New-cluster offsets
   can repeat. Select explicit distinct topic names for all three routes, or
   prove another existing configuration prevents collisions. No implicit topic
   generation or application transport-epoch migration is authorized.
4. **Current-image qualification:** producer, sink and archive paths must pass
   against stock Kafka with the existing `REDPANDA_BROKERS` contract. A local
   protocol-only test does not qualify R2 tiered retention or a full service boot.

## Ordered review and execution boundaries

After all stop gates are resolved, fill in exact topic assignments, image
references, operator commands and expected outputs in this packet. Use stock
[Swarm service updates](https://docs.docker.com/reference/cli/docker/service/update/)
and [Kafka topic tools](https://kafka.apache.org/44/operations/basic-kafka-operations/),
not a new deployment CLI or the full-stack application workflow.

1. Verify working instrumentation and capture the current service/image snapshot,
   source topic partition counts and high watermarks. Capture committed offsets
   for the three ClickHouse sink groups and three matching R2 archive groups.
   Use the existing legacy/live/history service-to-topic contract, not inferred
   defaults. Record all six groups individually.
2. Prepare the isolated Kafka service with its dedicated data directory,
   checksum-qualified plugin directory and dedicated R2 credentials. Keep every
   application endpoint pointed at Redpanda. Verify Kafka API readiness with an
   external JVM and create the explicitly reviewed source/quarantine topics.
   Record topic IDs, partition counts, RF and full retention configuration.
3. Pause ingress and all writers using the reviewed service task templates.
   Drain in-flight work; capture final old-cluster high watermarks. Require each
   of the six consumer groups to reach its own source boundary and prove archive
   writes succeeded. A single zero-lag observation is not an archive identity
   audit; do not repeat completed historical body scans.
4. Stop the six old consumers and Redpanda, preserving their exact task templates
   and data tree. Verify actual tasks have stopped, not just desired replicas.
   Do not prune the stack or run application/schema migrations.
5. Apply the reviewed endpoint/topic changes to the existing image of each
   consumer service. Start and verify all six routes on Kafka. Keep writers
   paused until readiness, topic identity, group assignment and archive output
   boundaries match the approved packet.
6. Record the **first Kafka application write** as a distinct recovery boundary.
   Resume the same writer images with the reviewed endpoint/topic settings.
   Verify all six consumers, persisted archive objects, application readiness,
   Kafka/R2 errors and resource limits under the bounded agreed observation.

## Recovery

Before the first Kafka application write, reversal may restore the captured
old service templates and Redpanda endpoints only after proving the new-cluster
application offsets remain empty. Restore the original replica counts and verify
all six original routes before reopening ingress. Do not infer reversal safety
from a failed deployment step alone.

After the first Kafka application write, stop writers and preserve both logs.
Use a separately reviewed forward-recovery plan. Do not flip back, reset offsets,
manually acknowledge messages, replay archives or delete either data tree.

Document exact symptoms, first fatal log line, user impact, recovery boundary,
mitigation and remaining risks in the production incident baseline if any
activation step fails. The [Swarm task-state reference](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/)
explains why desired replica counts alone are insufficient evidence.
