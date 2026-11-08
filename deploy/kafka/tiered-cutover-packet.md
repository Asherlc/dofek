# Kafka with tiered storage: release proposal

**Canonical review packet; no command below is authorized for execution.**
This combines broker PR #3233 and tiered PR #3236 as production dependencies,
while keeping their source-review layers separate. The intended first cutover
uses stock Kafka 4.4.0, upstream Aiven 1.2.0 and the existing R2 backend. There is
no standalone hot-log deployment stage, plugin fork or new deployment framework.

The [earlier broker packet](https://github.com/Asherlc/dofek/blob/4096c83cf/deploy/kafka/cutover-packet.md)
and [hot-log commands](https://github.com/Asherlc/dofek/blob/4096c83cf/deploy/kafka/operator-proposal.md)
are provenance only. Their remote-disabled settings and worker digest are not
execution inputs. Old aborted cutover commands are not authorized for reuse.

## Artifacts and limits

| Role | Immutable review input |
|---|---|
| Kafka | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| New worker only | `ghcr.io/asherlc/dofek@sha256:a0d8861a791fec7d043237b44158f38c57b35c17f79e0bcd1a3cf1a021f2979c` |
| Worker source | `e19b9200196c698e1d159597fc359d384d3a9a8e` |
| Observed web / legacy and live sinks | `ghcr.io/asherlc/dofek@sha256:b5676e5616082a09184397f0ea328b28e9d1320c4124cbafaf4f0578899e2d84` |
| Observed repaired history sink | `ghcr.io/asherlc/dofek@sha256:d8ca75d14b4da18057f3cf43d34889adf3d65c4927caccee69a8cee34e8120a1` |
| Observed three archives | `docker.redpanda.com/redpandadata/connect:4.99.0@sha256:0e1fb0a8c14d8752e3bb56a317ebe0867bdb61873fe2bb3cfcb64f9139589989` |

Existing-image observations are dated November 8, not a fresh production
inspection. Refresh privately before approval. Changed images/templates require
review. Preserve ClickHouse 26.6, PeerDB, archive identity, configs/secrets,
networks, healthchecks, resources and the worker job-files mount.

[Worker build](https://github.com/Asherlc/dofek/actions/runs/42530141695) and
[child qualification](../../docs/evidence/kafka-tiered-child-20261108/README.md)
bind the image to actual retention-phase/native/S3 checks. Remote-only reads
survived restart; orphan objects, unfinished MPUs and both retained broker roots
blocked the phase. Unrelated backup/processor/PeerDB gates were explicit stubs.
This is not full queue-driven worker boot, R2-cloud, power-loss, capacity or
archive-restore proof. [CI at `7be7d1547`](https://github.com/Asherlc/dofek/actions/runs/42532677882)
passed 97 jobs with six skipped, including all mutation/integration shards.

Later main synchronization brings #3235's history/sample-identity changes into
source, not into the pinned image. The seven receipt runtime files remain
identical; merged-head CI is separately required. A later full application image
needs its own qualification. Compare the actual worker source, not a moving head:

```sh
git diff --name-only f02798b72a144d137a0bd06ca111ad23f0c2c800 e19b9200196c698e1d159597fc359d384d3a9a8e
git diff f02798b72a144d137a0bd06ca111ad23f0c2c800 e19b9200196c698e1d159597fc359d384d3a9a8e -- src/jobs src/account-erasure src/metric-stream src/processing src/providers src/db
git diff f02798b72a144d137a0bd06ca111ad23f0c2c800 e19b9200196c698e1d159597fc359d384d3a9a8e -- drizzle/meta/_journal.json src/db/clickhouse-migrations/registry.ts
```

The journals match; that proves no new tracked migration, not blanket application
compatibility. Worker-executable changes include the four `kafka-*` storage/
history/record modules, `redpanda-drain.ts`, runtime/phase runner and structural
scrub in `src/db/account-erasure-processing.ts`. Baseline changes include the
bounded archive reader/parser and publisher type extraction in FIT jobs/provider
persisters. Preserve the [existing qualification limits](../../docs/pulsar-foundation-qualification.md);
no historical payload audit needs repeating.

## Decisions and prerequisites to bind together

- **Backend:** the existing renderer supplies `KAFKA_CLUSTER_ID` and five
  `KAFKA_TIERED_STORAGE_*` inputs to both processes; region is `auto`, prefix
  `<clusterId>/`. Verify actual consumed endpoint/bucket/credential scope through
  existing secret-safe tooling. Admin redacts RSM values; terminal metadata
  cannot prove backend equality. No production export/store edit occurred here.
- **Policy/capacity:** choose source global retention and source/quarantine local
  limits from the [measurement proposal](replay-capacity-options.md), including
  database growth, segments/indexes and delayed-cleanup headroom. Shorter retention
  to fit disk is acceptable in planning; exact values remain unselected. Keep
  quarantine global retention seven days / 1 GiB. Offload outage can exceed local
  targets; they are not hard disk caps. RF1/asynchronous upload does not survive
  irreversible only-disk loss. Archive bytes are retained; [operator-ready replay
  is not shipped](../../docs/metric-stream-redpanda-r2-runbook.md#replay). Qualify
  history against the reader's 64-MiB/100,000-segment/30-second envelope; exceeding
  it holds completion. No new production measurements are authorized now.
- **Old requests/data:** finish old-generation erasures on the old worker; never
  fabricate UUIDs. Preserve `/mnt/dofek-data/redpanda` and the aborted
  `/mnt/dofek-data/kafka/data` in place. Both stay read-only holds; any entry
  blocks completion. Agree deadline impact and separately approved retirement.
  Unknown old remote entries under the prefix also block; do not delete/exclude
  them silently. This packet has no old-data deletion/move or replacement root.
- **Execution:** freeze complete task templates, ingress/all-writer pause/drain,
  six old group boundaries, archive-delivery checks, observation interval,
  first-write authority and recovery ownership. A reviewed forward-recovery plan,
  named owner and stop conditions must be approved **before any first-write
  authority**; missing recovery instructions are a no-go. Low offsets alone prove
  neither physical deletion nor persisted archive delivery.
- **Erasure combination:** PR #3234 must preserve all six structural fields
  (`topic/partition/low/offset/clusterId/topicId`) and this retention hook alongside
  its newer stores/leases/fences. No wholesale runtime/scrub copy or duplicate
  guard. Its separate writer-safety decision is not covered by Kafka risk acceptance.
- **Topic identity:** explicitly accept all six names. Fresh source names below
  avoid old offsets colliding with archive keys. Each gets `.quarantine.v1`, one
  partition, RF1 and tiering. Unexpected pre-existing identities stop preparation.

| Route | Proposed source name |
|---|---|
| Legacy | `metric-stream-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |
| Live | `metric-stream-live-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |
| History | `metric-stream-history-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |

See [Kafka retention/tiering](https://kafka.apache.org/44/configuration/topic-configs/)
and [Aiven key layout](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java).

## Proposed execution — production approval required

### 1. Private freeze and configuration

Use an approved operator context on the intended Swarm. Save full inspect output
only in a private operator directory (`umask 077`); it contains credentials.
Record original specs/replicas/images and consumed routing. Verify instrumentation
and six group positions against their own source high watermarks.

Prepare broker/worker environments with the existing canonical export/renderer:

```sh
pnpm tsx scripts/render-deploy-service-env.ts "${reviewed_dotenv_path:?Private canonical export required}" "${service_env_directory:?Private output required}"
```

Use existing secret-safe tooling to bind those same reviewed inputs into the
operator environment. Do not shell-source dotenv, use `set -x`, print credentials
or add a parser. Compare cluster ID with the frozen stopped Kafka spec privately.
Missing/inconsistent inputs stop execution. Global route configuration must also
converge before normal release; no Infisical mutation is authorized here.

### 2. Stopped broker specification

Keep Kafka at zero replicas and application endpoints on Redpanda. Verify the
existing Aiven installation against [qualified provenance/checksums](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-lab-20261106/plugin-provenance.json).
Do not accept partial plugin directories, reuse/format the aborted tree, download
archives under this offline request or remove managed R2/Terraform resources.

These directory mutations require separate approval and run on the actual broker
host, not the operator workstation. Require a genuinely fresh data path; preserve
the old roots and existing plugin installation:

```sh
sudo mkdir -p /mnt/dofek-data/kafka-broker/data
sudo chown 1000:1000 /mnt/dofek-data/kafka-broker/data
```

In operator Bash, replace only the stopped broker's reviewed environment/mounts
with the canonical [stack stanza](../stack.yml), preserving other frozen fields.
All original environment keys are replaced, including the same validated cluster
ID. This is an unexecuted proposal:

```sh
set -euo pipefail
set +x
: "${KAFKA_CLUSTER_ID:?Reviewed cluster ID required}"
: "${KAFKA_TIERED_STORAGE_BUCKET:?Reviewed bucket required}"
: "${KAFKA_TIERED_STORAGE_ENDPOINT:?Reviewed endpoint required}"
: "${KAFKA_TIERED_STORAGE_REGION:?Reviewed region required}"
: "${KAFKA_TIERED_STORAGE_ACCESS_KEY_ID:?Reviewed credential required}"
: "${KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY:?Reviewed credential required}"
test "$KAFKA_TIERED_STORAGE_REGION" = auto
old_kafka_keys="$(
  docker service inspect dofek_kafka |
    jq -er '.[0].Spec.TaskTemplate.ContainerSpec.Env[] | split("=")[0]'
)"
remove_environment=()
while IFS= read -r key; do remove_environment+=(--env-rm "$key"); done <<< "$old_kafka_keys"
docker service update dofek_kafka --replicas 0 --hostname kafka \
  "${remove_environment[@]}" \
  --image apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --mount-rm /var/lib/kafka/data --mount-rm /plugins \
  --mount-add type=bind,source=/mnt/dofek-data/kafka-broker/data,target=/var/lib/kafka/data \
  --mount-add type=bind,source=/mnt/dofek-data/kafka/plugins,target=/plugins,readonly \
  --env-add "CLUSTER_ID=$KAFKA_CLUSTER_ID" \
  --env-add KAFKA_HEAP_OPTS='-Xmx1G -Xms1G' --env-add KAFKA_LOG_DIRS=/var/lib/kafka/data \
  --env-add KAFKA_PROCESS_ROLES=broker,controller --env-add KAFKA_NODE_ID=1 \
  --env-add KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:29093 \
  --env-add KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
  --env-add KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092 \
  --env-add KAFKA_LISTENERS=CONTROLLER://:29093,PLAINTEXT://:9092 \
  --env-add KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT --env-add KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  --env-add KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
  --env-add KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 --env-add KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
  --env-add KAFKA_AUTO_CREATE_TOPICS_ENABLE=false --env-add KAFKA_REMOTE_LOG_STORAGE_SYSTEM_ENABLE=true \
  --env-add KAFKA_REMOTE_LOG_STORAGE_MANAGER_CLASS_PATH='/plugins/1.2.0/core/*:/plugins/1.2.0/s3/*' \
  --env-add KAFKA_REMOTE_LOG_STORAGE_MANAGER_CLASS_NAME=io.aiven.kafka.tieredstorage.RemoteStorageManager \
  --env-add KAFKA_REMOTE_LOG_METADATA_MANAGER_CLASS_NAME=org.apache.kafka.server.log.remote.metadata.storage.TopicBasedRemoteLogMetadataManager \
  --env-add KAFKA_REMOTE_LOG_METADATA_MANAGER_LISTENER_NAME=PLAINTEXT \
  --env-add KAFKA_RLMM_CONFIG_REMOTE_LOG_METADATA_TOPIC_REPLICATION_FACTOR=1 \
  --env-add KAFKA_RLMM_CONFIG_REMOTE_LOG_METADATA_TOPIC_MIN_ISR=1 \
  --env-add KAFKA_RSM_CONFIG_CHUNK_SIZE=4194304 \
  --env-add KAFKA_RSM_CONFIG_FETCH_CHUNK_CACHE_CLASS=io.aiven.kafka.tieredstorage.fetch.cache.MemoryChunkCache \
  --env-add KAFKA_RSM_CONFIG_FETCH_CHUNK_CACHE_SIZE=67108864 \
  --env-add KAFKA_RSM_CONFIG_FETCH_CHUNK_CACHE_PREFETCH_MAX_SIZE=4194304 \
  --env-add KAFKA_RSM_CONFIG_STORAGE_BACKEND_CLASS=io.aiven.kafka.tieredstorage.storage.s3.S3Storage \
  --env-add KAFKA_RSM_CONFIG_STORAGE_S3_PATH_STYLE_ACCESS_ENABLED=true \
  --env-add "KAFKA_RSM_CONFIG_STORAGE_S3_BUCKET_NAME=$KAFKA_TIERED_STORAGE_BUCKET" \
  --env-add "KAFKA_RSM_CONFIG_STORAGE_S3_ENDPOINT_URL=$KAFKA_TIERED_STORAGE_ENDPOINT" \
  --env-add "KAFKA_RSM_CONFIG_STORAGE_S3_REGION=$KAFKA_TIERED_STORAGE_REGION" \
  --env-add "KAFKA_RSM_CONFIG_KEY_PREFIX=$KAFKA_CLUSTER_ID/" \
  --env-add "AWS_ACCESS_KEY_ID=$KAFKA_TIERED_STORAGE_ACCESS_KEY_ID" \
  --env-add "AWS_SECRET_ACCESS_KEY=$KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY" \
  --env-add AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED \
  --env-add AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED --limit-memory 2048M
```

Docker's [stock update implementation](https://github.com/docker/cli/blob/master/cli/command/service/update.go#L695-L714)
removes named old environment entries before applying replacements. Inspect the
result privately; this does not permit trusting an earlier failed inspect or
missing input. The assignment above propagates inspect/jq failure before mutation.

Verify resulting private spec and actual consumed/generated settings, not just
intended variables. Then start Kafka alone and use an external operator JVM:

```sh
docker service update dofek_kafka --replicas 1
docker run --rm --network dofek_default --memory 384m \
  -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
  --entrypoint /opt/kafka/bin/kafka-broker-api-versions.sh \
  apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --bootstrap-server kafka:9092
```

Check actual tasks, native cluster/node identity, one log directory and plugin
startup. Port liveness is insufficient. No application/synthetic production write
is part of this preparation. See [service update](https://docs.docker.com/reference/cli/docker/service/update/).

### 3. Six topic identities

For each accepted source/quarantine topic, bind the reviewed global/local/segment
policy. Quarantine global values remain `604800000` ms / `1073741824` bytes.
Creation must fail if identity already exists; do not use `--if-not-exists`.

```sh
docker run --rm --network dofek_default --memory 384m \
  -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
  --entrypoint /opt/kafka/bin/kafka-topics.sh \
  apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --bootstrap-server kafka:9092 --create --topic "${accepted_topic:?Accepted topic required}" \
  --partitions 1 --replication-factor 1 --config cleanup.policy=delete \
  --config remote.storage.enable=true \
  --config "retention.ms=${accepted_retention_ms:?Reviewed global retention required}" \
  --config "retention.bytes=${accepted_retention_bytes:?Reviewed global byte policy required}" \
  --config "local.retention.ms=${accepted_local_retention_ms:?Reviewed local retention required}" \
  --config "local.retention.bytes=${accepted_local_retention_bytes:?Reviewed local byte policy required}" \
  --config "segment.bytes=${accepted_segment_bytes:?Reviewed segment size required}" \
  --config "segment.ms=${accepted_segment_ms:?Reviewed segment age required}"
docker run --rm --network dofek_default --memory 384m \
  -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
  --entrypoint /opt/kafka/bin/kafka-topics.sh \
  apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --bootstrap-server kafka:9092 --describe --topic "$accepted_topic"
docker run --rm --network dofek_default --memory 384m \
  -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
  --entrypoint /opt/kafka/bin/kafka-configs.sh \
  apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f \
  --bootstrap-server kafka:9092 --entity-type topics --entity-name "$accepted_topic" --describe --all
```

Record native UUIDs, RF/ISR, configs and empty application offsets. Verify prefix
object/MPU scope and native history through existing tooling; unknown old entries
stop preparation. This proposed release check authorizes no new production
listing or payload scan now.

### 4. Pause, drain and bind individual services

After the approved ingress/all-writer pause, finish in-flight work and freeze old
source boundaries. All six old groups must drain their own routes; verify archive
delivery too. Finish old-generation erasures before stopping the old worker.
Stop old consumers and Redpanda only after drain; verify actual task exit and
preserve their templates/trees. Keep affected application services at zero while
binding the reviewed changes; retain every other original field:

| `dofek_` suffix | Broker key | Route / image |
|---|---|---|
| `web` | `REDPANDA_BROKERS` | All three explicit sources; preserve image |
| `worker` | `REDPANDA_BROKERS` | All three sources; only this image changes |
| `metric-stream-clickhouse-sink` | `REDPANDA_BROKERS` | Legacy; preserve image/group |
| `metric-stream-live-clickhouse-sink` | `REDPANDA_BROKERS` | Live; preserve image/group |
| `metric-stream-history-clickhouse-sink` | `KAFKA_BROKERS` | History; preserve repaired image/group |
| `metric-stream-r2-archive` | `REDPANDA_BROKERS` | Legacy; preserve Connect image/config/group |
| `metric-stream-live-r2-archive` | `REDPANDA_BROKERS` | Live; preserve Connect image/config/group |
| `metric-stream-history-r2-archive` | `REDPANDA_BROKERS` | History; preserve Connect image/config/group |

Preserve each image/group/config while updating the stopped routes. The repaired
history sink's key is intentionally different:

```sh
docker service update dofek_metric-stream-clickhouse-sink --replicas 0 \
  --env-add REDPANDA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_TOPIC=${accepted_legacy_topic:?Accepted legacy route required}"
docker service update dofek_metric-stream-live-clickhouse-sink --replicas 0 \
  --env-add REDPANDA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_TOPIC=${accepted_live_topic:?Accepted live route required}"
docker service update dofek_metric-stream-history-clickhouse-sink --replicas 0 \
  --env-add KAFKA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_TOPIC=${accepted_history_topic:?Accepted history route required}"
docker service update dofek_metric-stream-r2-archive --replicas 0 \
  --env-add REDPANDA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_TOPIC=${accepted_legacy_topic:?Accepted legacy route required}"
docker service update dofek_metric-stream-live-r2-archive --replicas 0 \
  --env-add REDPANDA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_TOPIC=${accepted_live_topic:?Accepted live route required}"
docker service update dofek_metric-stream-history-r2-archive --replicas 0 \
  --env-add REDPANDA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_TOPIC=${accepted_history_topic:?Accepted history route required}"
docker service update dofek_web --replicas 0 \
  --env-add REDPANDA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_LEGACY_TOPIC=${accepted_legacy_topic:?Accepted legacy route required}" \
  --env-add "METRIC_STREAM_LIVE_TOPIC=${accepted_live_topic:?Accepted live route required}" \
  --env-add "METRIC_STREAM_HISTORY_TOPIC=${accepted_history_topic:?Accepted history route required}"
```

Bind the stopped worker image, three read-only mounts and same reviewed backend
inputs as Kafka, preserving all current secrets, other env, healthchecks,
resources and job-files mount:

```sh
docker service update dofek_worker --replicas 0 \
  --image ghcr.io/asherlc/dofek@sha256:a0d8861a791fec7d043237b44158f38c57b35c17f79e0bcd1a3cf1a021f2979c \
  --mount-add type=bind,source=/mnt/dofek-data/kafka-broker/data,target=/var/lib/dofek/kafka-data,readonly \
  --mount-add type=bind,source=/mnt/dofek-data/redpanda,target=/var/lib/dofek/retired-broker-data,readonly \
  --mount-add type=bind,source=/mnt/dofek-data/kafka/data,target=/var/lib/dofek/aborted-kafka-data,readonly \
  --env-add REDPANDA_BROKERS=kafka:9092 \
  --env-add "METRIC_STREAM_LEGACY_TOPIC=${accepted_legacy_topic:?Accepted legacy route required}" \
  --env-add "METRIC_STREAM_LIVE_TOPIC=${accepted_live_topic:?Accepted live route required}" \
  --env-add "METRIC_STREAM_HISTORY_TOPIC=${accepted_history_topic:?Accepted history route required}" \
  --env-add "KAFKA_CLUSTER_ID=${KAFKA_CLUSTER_ID:?Reviewed cluster ID required}" \
  --env-add "KAFKA_TIERED_STORAGE_BUCKET=${KAFKA_TIERED_STORAGE_BUCKET:?Reviewed bucket required}" \
  --env-add "KAFKA_TIERED_STORAGE_ENDPOINT=${KAFKA_TIERED_STORAGE_ENDPOINT:?Reviewed endpoint required}" \
  --env-add "KAFKA_TIERED_STORAGE_REGION=${KAFKA_TIERED_STORAGE_REGION:?Reviewed region required}" \
  --env-add "KAFKA_TIERED_STORAGE_ACCESS_KEY_ID=${KAFKA_TIERED_STORAGE_ACCESS_KEY_ID:?Reviewed credential required}" \
  --env-add "KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY=${KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY:?Reviewed credential required}" \
  --entrypoint node \
  --args '--env-file=.env --experimental-strip-types --enable-source-maps --disable-warning=ExperimentalWarning --import ./src/opentelemetry-hook.mjs --import ./src/instrumentation.ts src/jobs/worker.ts'
```

This production Node path avoids `entrypoint.sh worker`'s migration launcher.
Matching journals do not authorize migrations. Image qualification imported the
actual phase with these preloads; startup of every queue remains a production
release check. Existing environment wins over [Node env-file defaults](https://nodejs.org/api/cli.html#--env-filefile).
Apply all three explicit source settings to web too, retaining its image. Use
frozen templates and stock service updates, never partial service recreation or
a pruned full stack. Verify every command against its refreshed template before
requesting execution approval.

### 5. First-write authority and consumer/writer startup

Before starting consumers, freeze the zero-new-write check and applicable
authority. Consumers are not assumed read-only: the [actual consumer](../../src/metric-stream/redpanda-consumer.ts)
can [publish rejected payloads to quarantine](../../src/metric-stream/redpanda-quarantine.ts).
Starting such a consumer requires first-write authority unless the reviewed
no-write precondition covers it too. All six new source/quarantine application
topics, every enabled writer and queued/in-flight work belong in that proof;
Kafka internal metadata/group writes are distinct. With that condition met,
start the six consumers with existing replica/group/image contracts; verify
topic generations, assignments, archive configuration, errors and readiness.
Keep web/worker and other writers stopped. **Starting the worker can process
queued jobs immediately and needs first-write authority**, even before web
traffic. Do not start it merely to
preflight readiness. After explicit authority, record the first application-write
boundary and resume reviewed web/worker/other writers. Verify readiness, consumer
progress, persisted archive delivery and resources for the agreed interval.
No synthetic production write is authorized. Unknown config/schema, incomplete
drain, unexplained object/native bytes or an unqualified image stops execution.
Before enabling any possible application writer, require the already approved
stop/preserve/forward-recovery instructions and named response owner.

## Recovery and retained bytes

Before any Kafka application write, restore saved original templates only after
zero-new-write proof across **all six source/quarantine application topics and
every enabled writer**, including consumer quarantine publication. Stop affected
tasks and verify actual exit before restoration; verify the frozen specs/routes,
original replica counts and all six old routes before reopening old ingress.
Generic `docker service rollback` restores one immediately previous spec, not this
operation's full history. After a write, execute the **already approved**
stop/preserve/forward-recovery plan under its named owner and stop conditions.
Preserve both logs. Never flip back,
reset offsets, manually acknowledge, replay archives or delete/move old bytes
under cutover authority. Record first fatal logs and remaining risks in the
[incident baseline](../../docs/production-incident-baseline.md). Desired replicas
alone are not [actual task exit](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/).

Freeze the executing operator and incident owner by name before permission.
The operator owns immediate stop/preserve actions; the incident owner owns
forward restoration and any later resume decision. The approved plan must bind
the exact all-writer stop commands/templates (including quarantine producers),
Kafka-first restoration scope, checks for acknowledged records/consumer/archive
progress, and explicit resume criteria. Lost Kafka data, uncertain write history,
unproven restore capability or a failed check leaves writers stopped; do not
invent archive replay or a Redpanda cutback during the incident. This packet's
RF1/restore limits remain visible when that recovery scope is approved.

Both retained roots block completion while nonempty. The aborted-attempt
no-application-write receipt is provenance, not permission to omit its hold.
Retirement needs separate scope/recovery/deadline approval; no deletion command
or empty-root substitution belongs in this packet.

## Source landing / automatic deployment: unresolved integration gate

The proposed order is tiered broker-only cutover with both PRs open, then a
separately qualified full application release. No production step, exact policy,
merge order or application rollout is authorized by the source split.

[Main CI triggers deployment](../../.github/workflows/deploy-web.yml). The
[pipeline](../../.github/workflows/deploy-web-environment.yml) runs Terraform before
the [stack job](../../.github/workflows/deploy-web-stack.yml) requires active Kafka
and stopped Redpanda. Its shared `APP_IMAGE` cannot preserve this packet's separate
history-image pin. Qualify that later release's history repair, schema/Terraform
effects, scrub combination and canonical worker entrypoint restoration separately.

**Do not merge the broker-only parent alone after tiered activation:** its
remote-disabled configuration could deploy automatically and turn tiering off.
Racing the child merge against parent CI is unsafe. Do not disable automation,
add flags or silently change workflow strategy.

One stock landing proposal for explicit review is to retarget the complete child
graph to main after both layers and the full application release are qualified,
then land the full graph in one authorized merge. It includes the parent and
avoids an intermediate remote-disabled main release; reconcile parent PR
bookkeeping afterward. This is **not selected or executed**. Both current PR bases
and all triggers remain unchanged. Resolve it with the operational decision
bundle before any merge/cutover execution request.

## Accepted residual

An earlier unknown-outcome PUT may commit after deletion/final verification,
leaving an orphan indefinitely. The user accepted this specific exception;
[R2 documents the ordering](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).
Normal native terminal history, complete object/MPU listing, local/cache removal,
generation and retained-root checks remain mandatory. No custom fence, plugin
fork, manual acknowledgement or per-user sharding is selected. Structural keys
locate later orphans by generation/partition/segment, not user; manual cleanup
needs separate scope/approval.
