# Broker-only operator proposal

For the separate phase-2 review, see the [tiered-storage reference](tiered-cutover-packet.md).
It does not authorize tiered activation or repeating the phase-1 commands below.

**Phase 1 command record.** The user approved the [single approval bundle](phase1-approval.md)
with “Y” (Q4/A) on November 9 UTC. See the [execution receipt](phase1-execution.md)
for actual state; these commands are not permission to repeat the cutover.
The user now explicitly requests Kafka first, then tiered storage. These stock
commands prepare the Kafka-only phase with its qualified local-storage worker.
Tiering belongs to the separate phase-2 PR. Freeze the proposed 4-GiB source /
existing 1-GiB quarantine byte policy, 128-MiB segments, 20-GiB reserve and
pause/recovery/monitoring scope from the bundle before execution. No data
retirement or automatic full application release is implied.

## Observed service contract

A names-only/public-routing Swarm inspection on November 8 confirmed Kafka at
zero replicas, Redpanda at one, web at two, worker at one and each consumer at
one. Kafka still mounts the aborted tree and `/plugins`. Worker has only its
existing job-files volume; it has neither new read-only mount. Preserve the
existing secrets, network attachments, configs, labels, health checks, resources
and job-files volume. Do not recreate application services from partial examples.

| Service suffix under `dofek_` | Broker environment key | Current topic | New topic route |
|---|---|---|---|
| `web`, `worker` | `REDPANDA_BROKERS` | Three route settings; web's legacy setting is currently implicit | Set all three explicit source settings |
| `metric-stream-clickhouse-sink` | `REDPANDA_BROKERS` | `metric-stream-v1` | Legacy |
| `metric-stream-live-clickhouse-sink` | `REDPANDA_BROKERS` | `metric-stream-live-v1` | Live |
| `metric-stream-history-clickhouse-sink` | `KAFKA_BROKERS` | `metric-stream-history-v1` | History |
| `metric-stream-r2-archive` | `REDPANDA_BROKERS` | `metric-stream-v1` | Legacy |
| `metric-stream-live-r2-archive` | `REDPANDA_BROKERS` | `metric-stream-live-v1` | Live |
| `metric-stream-history-r2-archive` | `REDPANDA_BROKERS` | `metric-stream-history-v1` | History |

Use the immutable image table in the packet. Consumer group names remain the
same as their service suffixes. Connect retains its v5 config object and original
S3 output. Updating endpoints/topics does not update global Infisical values;
that separate configuration-convergence action must be approved before a later
normal deployment can consume the new route configuration.

Docker documents [service updates](https://docs.docker.com/reference/cli/docker/service/update/)
and [task inspection](https://docs.docker.com/reference/cli/docker/service/ps/).

## Freeze before requesting execution

Capture the exact current service specifications into a private operator
directory with mode 0700 and files mode 0600, including original command/args,
images, replica counts and environment assignments. Do not print credentials.
Record the six group positions against their final source boundaries, producer
pause/drain mechanism, active old-generation erasure requests, current disk/RAM
headroom, peak ingestion/backfill bytes and the agreed observation interval.
An empty source offset alone is not physical-erasure evidence. Unknown or
incomplete entries stop the proposal; approval must bind the completed packet.

Keep separate recovery instructions for the exact saved task templates. A
generic `docker service rollback` restores only the immediately previous service
specification; this proposal involves multiple updates. It is not a substitute
for restoring the original templates and the pre-write recovery proof.

## Broker preparation proposal

Keep replicas at zero while replacing the stopped Kafka service's specification.
Preserve its current `CLUSTER_ID`; do not print it, reformat an existing tree or
reuse the old data directory. Production host directory creation/chown is an
explicit mutation requiring approval. The intended fresh directory is
`/mnt/dofek-data/kafka-broker/data`, owned by 1000:1000.

The existing service has precisely the old data and plugin mounts. After
reviewing its frozen specification, these stock Bash/jq/Docker commands replace
the service environment with the [canonical broker stanza](../stack.yml), keeping
the existing cluster ID private. Remove the old data mount in the first stopped
update, then add the replacement in a separate stopped update. The first execution
observed `Mounts: null` when removal and addition targeted the same path in one
command; inspect the final specification before any start:

```sh
set -euo pipefail
if ! old_kafka_keys="$(
  docker service inspect dofek_kafka |
    jq -er '.[0].Spec.TaskTemplate.ContainerSpec.Env[] | split("=")[0] | select(. != "CLUSTER_ID")'
)"; then
  echo "Kafka environment inspection failed; stopped service was not updated" >&2
  exit 1
fi
remove_environment=()
while IFS= read -r key; do
  remove_environment+=(--env-rm "$key")
done <<< "$old_kafka_keys"
docker service update dofek_kafka \
  --replicas 0 --hostname kafka \
  "${remove_environment[@]}" \
  --image apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --mount-rm /plugins --mount-rm /var/lib/kafka/data \
  --env-add KAFKA_HEAP_OPTS='-Xmx1G -Xms1G' \
  --env-add KAFKA_LOG_DIRS=/var/lib/kafka/data \
  --env-add KAFKA_PROCESS_ROLES=broker,controller \
  --env-add KAFKA_NODE_ID=1 \
  --env-add KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:29093 \
  --env-add KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
  --env-add KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092 \
  --env-add KAFKA_LISTENERS=CONTROLLER://:29093,PLAINTEXT://:9092 \
  --env-add KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT \
  --env-add KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  --env-add KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
  --env-add KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
  --env-add KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
  --env-add KAFKA_AUTO_CREATE_TOPICS_ENABLE=false \
  --env-add KAFKA_REMOTE_LOG_STORAGE_SYSTEM_ENABLE=false \
  --limit-memory 2048M
docker service update dofek_kafka --replicas 0 \
  --mount-add type=bind,source=/mnt/dofek-data/kafka-broker/data,target=/var/lib/kafka/data
docker service inspect dofek_kafka --format '{{json .Spec.TaskTemplate.ContainerSpec.Mounts}}'
```

**All old environment assignments except `CLUSTER_ID` are removed and replaced
with the canonical hot-log stanza in the same reviewed operation**. Merely adding
`KAFKA_REMOTE_LOG_STORAGE_SYSTEM_ENABLE=false` leaves obsolete plugin/S3/cache
settings and credentials. The names-only inspection identified these families:
`KAFKA_REMOTE_LOG_*`, `KAFKA_RLMM_CONFIG_*`, `KAFKA_RSM_CONFIG_*` and `AWS_*`.
Use stock `--env-rm`/`--env-add` flags; retain only `CLUSTER_ID` from the old
environment. Preserve all managed R2 resources and both old host trees.

After approved specification review, start Kafka alone. An external operator
container, outside the broker memory cgroup, must verify the API and metadata:

```sh
docker run --rm --network dofek_default --memory 384m \
  -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
  --entrypoint /opt/kafka/bin/kafka-broker-api-versions.sh \
  apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --bootstrap-server kafka:9092
```

Create each explicitly accepted source and quarantine topic with one partition,
RF1, `cleanup.policy=delete` and `remote.storage.enable=false`, using stock
`kafka-topics.sh --create`. Do not use `--if-not-exists` to accept a pre-existing
identity. Describe every created topic/config and record native topic UUIDs.
Source retention values must come from the measured, accepted shorter-window
proposal. Quarantine keeps its existing `retention.ms=604800000` and
`retention.bytes=1073741824` contract; do not shorten that policy here.
Creation or unexpected prior existence is a stop point until the identity is
reviewed. See [Kafka topic configuration](https://kafka.apache.org/44/configuration/topic-configs/).

The creation command uses an explicitly accepted topic from the packet:

```sh
set -euo pipefail
accepted_legacy_topic=metric-stream-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3
accepted_live_topic=metric-stream-live-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3
accepted_history_topic=metric-stream-history-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3
for accepted_topic in \
  "$accepted_legacy_topic" "$accepted_live_topic" "$accepted_history_topic" \
  "$accepted_legacy_topic.quarantine.v1" "$accepted_live_topic.quarantine.v1" "$accepted_history_topic.quarantine.v1"; do
case "$accepted_topic" in
  *.quarantine.v1) accepted_retention_bytes=1073741824 ;;
  *) accepted_retention_bytes=4294967296 ;;
esac
accepted_retention_ms=604800000
docker run --rm --network dofek_default --memory 384m \
  -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
  --entrypoint /opt/kafka/bin/kafka-topics.sh \
  apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --bootstrap-server kafka:9092 --create --topic "${accepted_topic:?Reviewed topic required}" \
  --partitions 1 --replication-factor 1 \
  --config cleanup.policy=delete \
  --config "retention.ms=${accepted_retention_ms:?Reviewed retention time required}" \
  --config "retention.bytes=${accepted_retention_bytes:?Reviewed byte limit required}" \
  --config segment.bytes=134217728 \
  --config remote.storage.enable=false
done
```

## Paused application updates

Only after the approved ingress/producer pause, completed in-flight drain and
all six old consumer boundaries, stop each old consumer and Redpanda and verify
its actual tasks have stopped. Keep every writer paused. For each row above,
update only its correct broker key to `kafka:9092` and topic assignment while
preserving its image and consumer group. Example for the repaired history sink:

```sh
docker service update dofek_metric-stream-history-clickhouse-sink \
  --replicas 0 \
  --env-add KAFKA_BROKERS=kafka:9092 \
  --env-add METRIC_STREAM_TOPIC=metric-stream-history-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3
```

Web and worker each need all three explicitly accepted route settings, including
the legacy setting missing from web's current environment. Do not rely on an
image default pointing at the old namespace. Keep web's existing image.

The worker alone changes to the pinned safety image, with the existing service
environment/secrets and job-files volume retained. Proposed additional flags:

```sh
docker service update dofek_worker \
  --replicas 0 \
  --image ghcr.io/asherlc/dofek@sha256:a498aaa503db452480fdd43a71cc8799aa2564eea30a070e0296a08effc48620 \
  --mount-add type=bind,source=/mnt/dofek-data/kafka-broker/data,target=/var/lib/dofek/kafka-data,readonly \
  --mount-add type=bind,source=/mnt/dofek-data/redpanda,target=/var/lib/dofek/retired-broker-data,readonly \
  --entrypoint node \
  --args '--env-file=.env --experimental-strip-types --enable-source-maps --disable-warning=ExperimentalWarning --import ./src/opentelemetry-hook.mjs --import ./src/instrumentation.ts src/jobs/worker.ts'
```

Combine the reviewed broker/topic environment changes with this stopped-worker
update. The explicit Node command proposes the existing worker program and
production telemetry preloads while avoiding `entrypoint.sh worker`'s migration
launcher. Stock Node [loads `.env` defaults with existing environment variables
taking precedence](https://nodejs.org/api/cli.html#--env-filefile). This exact flag
combination loaded defaults and imported the adapter in the pinned image with
network disabled; no worker, migration or HTTP server was started. This is a
launch/configuration check, not complete queue-driven worker qualification.

The later separately approved normal application release owns restoration to
its canonical worker command and its own migration checks. No repository
entrypoint, migration runner, feature flag or one-off runtime hook is added.
Before starting this proposed worker, verify all current required runtime keys,
native mounts and old-request preflight; any unknown prerequisite blocks start.

## Resume and recovery approval boundary

Start and verify all six consumer routes before writers. Resume web and worker
only with explicit first-write authority. Record that write boundary and verify
archive output identity/delivery, consumer progress, errors and resource use for
the agreed observation interval. No synthetic production write is authorized by
this proposal. Before the first application write, restore saved original
templates only after the packet's zero-new-write proof. After first-write
authority, execute the already approved stop/preserve/forward plan in the
[approval bundle](phase1-approval.md#recovery-and-old-data-boundary-approved-before-first-writes).
Missing forward-recovery prerequisites block writer release.

Retained Redpanda data continues to block final erasure completion. There is no
delete/move command in this cutover. Retirement needs its own approved operator
packet accounting for rollback and existing archive/backup gates.

## Kafka quarantine inspection

Use a one-shot administrative client on the existing overlay after Redpanda is
stopped. This uses the already-qualified Redpanda image solely for its `rpk`
client; it starts no broker and mounts no broker data. The native
[topic describe command](https://docs.redpanda.com/current/reference/rpk/rpk-topic/rpk-topic-describe/)
accepts explicit topic names without a regex and reports offsets without reading
record values:

```sh
set -euo pipefail
legacy=metric-stream-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3
live=metric-stream-live-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3
history=metric-stream-history-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3
docker run --rm --network dofek_default --memory 256m --entrypoint rpk \
  redpandadata/redpanda:v26.1.9@sha256:8cb52078690728e2b3d1507fc84eda4c07d4d59bd8fa241e9b1cc7eb7de096c9 \
  -X brokers=kafka:9092 topic describe \
  "$legacy.quarantine.v1" "$live.quarantine.v1" "$history.quarantine.v1" \
  --format json | jq '[.[] | {topic: .summary.name, partitions: [.partitions[] | {partition, log_start_offset, high_watermark}]}]'
```

The [completed phase-1 receipt](phase1-execution.md) records all three quarantine
high watermarks at zero. A later nonzero boundary requires diagnosis; it is not
permission to reset offsets, acknowledge, redrive or delete anything. Obtain a
separately bounded inspection scope before reading sensitive record bodies.
Zero offsets do not establish physical erasure.

## Remaining decision bundle

Q4/A approved this narrow operation with the exact topic names/policy, conservative
reserve monitoring despite unavailable peak history, old-data erasure hold and
frozen recovery boundaries. The [execution receipt](phase1-execution.md) records
its outcome. A broader shared application release/merge, tiering and data
retirement remain separate. If combining the erasure PR, preserve all six
structural checkpoint fields explicitly.
