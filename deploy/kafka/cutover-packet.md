# Broker-only cutover qualification packet

Status: **offline review candidate; not approved for activation**. The canonical
stack is now hot-log-only and the narrow worker guard has local qualification.
Image, capacity/policy and retirement gates below must close before final mutation
commands and a maintenance window are approved. Do not reuse the aborted combined
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
change belongs in the broker operation except the separately approved narrow
worker safety image. Keep web, both older sinks, the repaired history sink and
Connect individually pinned; do not roll them onto the new worker image.

## Canonical candidate specification

The normal deployment uses `deploy/stack.yml` plus `deploy/stack.oracle.yml`;
there is no hot-log overlay or mode flag to omit on a later release. A schema
render of those two files verified the following effective bindings:

| Service | Effective candidate |
|---|---|
| Kafka image | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| Remote storage | `KAFKA_REMOTE_LOG_STORAGE_SYSTEM_ENABLE=false`; no plugin mount or credentials |
| Broker data | `/mnt/dofek-data/kafka-hot-log/data` → `/var/lib/kafka/data` |
| Worker data view | Same host source → `/var/lib/dofek/kafka-data:ro` |
| Retired Redpanda hold | Original `/mnt/dofek-data/redpanda` → `/var/lib/dofek/retired-broker-data:ro` |
| Worker image | Must be replaced with the digest-pinned review build before approval |
| ClickHouse | Unchanged `26.6.1.1193-alpine` |

The fresh hot-log path avoids reusing the stopped tiered broker's configuration
and generation. Leave `/mnt/dofek-data/kafka/data` and any existing plugins
untouched. The [aborted-attempt receipt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-cutover-attempt-20261108/README.md)
records no application writes and zero latest offsets on all six new Kafka
topics before stop. Exclusion of that old tree from an account-data hold relies
on that specific no-application-write record, not on offset absence as a physical
deletion proof. Any contrary or unknown application-write history blocks the
proposal until that storage is included in the hold; do not scan historical bodies.
Already-managed R2/Terraform/Infisical resources remain declared and untouched.

## New-worker source review

The image will include both this branch's narrow guard and the already-merged
main baseline `2752451fb4a7404e5d887d32341595a42a673dcd`, rather than a literal
binary patch to deployed `f02798b72a144d137a0bd06ca111ad23f0c2c800`.
Use ordinary read-only source comparisons against the review image's source SHA:

```sh
git diff --name-only f02798b72a144d137a0bd06ca111ad23f0c2c800 HEAD
git diff f02798b72a144d137a0bd06ca111ad23f0c2c800 HEAD -- src/jobs src/account-erasure src/metric-stream src/processing src/providers src/db
git diff f02798b72a144d137a0bd06ca111ad23f0c2c800 HEAD -- drizzle/meta/_journal.json src/db/clickhouse-migrations/registry.ts
```

The worker entrypoint runs `src/db/run-migrate.ts`, then `src/jobs/worker.ts`.
The migration journals match the deployed source; that proves no new tracked
migrations in this candidate, not blanket application compatibility.

Worker-reachable baseline changes include the bounded archive reader in
`src/account-erasure/archive-erasure.ts`, `src/metric-stream/archive-lines.ts` and
the imported `src/metric-stream/r2-replay.ts` parser. FIT jobs, provider persisters,
`src/db/metric-stream-writer.ts`, `src/metric-stream/write-metric-stream.ts` and
`src/processing/metric-stream-processing-publisher.ts` switch type imports to
`src/metric-stream/publisher.ts`; producer interface declarations moved out of
`redpanda-producer.ts` without changing that producer's executable methods.
The selected provider paths are Apple Health `db-insertion.ts`/`import.ts`, Fitbit
`persisters.ts`, Polar `sync-service.ts`, `sync-run.ts` and Wahoo
`activity-persister.ts`. Server/mobile entrypoints, tests, development fixtures
and historical documentation are not additional production worker commands.
Review the source diff and the bounded archive-reader evidence already recorded
in [the baseline qualification](../../docs/pulsar-foundation-qualification.md);
do not repeat historical archive downloads or identity scans.

## Stop gates

1. **Qualified worker and configuration:** require the new worker image, matching
   read-only mounts and the canonical hot-log broker. The guard is wired into
   final retention and rejects remote storage; it is not a tiered-storage verifier.
   Existing requests without native generation checkpoints must finish on the
   old source before cutover. Do not fabricate UUIDs or reinterpret old offsets.
2. **Retired broker bytes:** stopping Redpanda also stops its retention work.
   Retaining its tree for rollback does not establish physical erasure. The new
   worker blocks final completion while any entry remains in the original root.
   Preserve that root in place; agree the hold and separately authorized retirement
   boundary before pausing production. Do not move or delete the old tree under
   cutover approval.
3. **Archive identity:** the retained Connect config writes keys containing
   topic, partition, UTC date/hour and first/last offsets. New-cluster offsets
   can repeat. Select explicit distinct topic names for all three routes, or
   prove another existing configuration prevents collisions. No implicit topic
   generation or application transport-epoch migration is authorized.
4. **Current-image qualification:** producer, sink and archive paths must pass
   against stock Kafka with the existing `REDPANDA_BROKERS` contract. A local
   protocol-only test does not qualify R2 tiered retention or a full service boot.

## Capacity and proposed topic policy

Read-only metadata on November 8 reported `/mnt/dofek-data` size
157,396,975,616 B, used 109,727,657,984 B and available 39,599,476,736 B
(about 36.9 GiB). This snapshot includes retained old trees. It is not a measured
ingest peak or a reservation against database growth.

| Route | Observed Redpanda byte retention | Time retention | Proposed hot-log byte target |
|---|---:|---:|---:|
| Legacy | 40 GiB | 7 days | 1 GiB |
| Live | Unlimited by bytes | 7 days | 1 GiB |
| History | Unlimited by bytes | 7 days | 1 GiB |

Quarantine uses the existing 1 GiB/seven-day policy. The six proposed targets
sum to 6 GiB before segment overshoot, indexes, metadata and delayed cleanup.
**The proposed source byte limits change the current replay policy.** They need
explicit policy acceptance and measured burst/headroom review; current free space
does not prove a safe outage window. The existing JSONL archive is durable but
requires explicit replay outside broker retention. No topic policy has been
changed. Kafka documents [retention](https://kafka.apache.org/44/configuration/topic-configs/).

Proposed fresh namespace (generated for this review, not yet applied):

| Route | Kafka source topic |
|---|---|
| Legacy | `metric-stream-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |
| Live | `metric-stream-live-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |
| History | `metric-stream-history-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |

Each source gets its existing `.quarantine.v1` suffix, one partition and RF1.
These names are distinct from the old v1/v2 namespaces; preserve all six existing
consumer group names and each actual image's broker-variable contract. The archive
key continues to include the source topic and offsets, so do not substitute an
old topic name on the fresh cluster. Approval must bind these names explicitly.

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
