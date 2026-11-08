# Controlled Kafka cutover proposal

Status: **preparation only; not approved for production execution**.
This replaces the unsafe full-stack transition described in the
[cutover review](README.md#production-cutover--rollback-review-not-executed).
Use a one-time operator session with stock Docker, Kafka, Infisical and the
existing repository release commands. Do not add a permanent cutover flag,
workflow branch, retry layer or migration framework.

## Release and scope

The qualified application source is
`9a16c806fc0ebe587c5d4e6665ac888f87beefa2`, image
`ghcr.io/asherlc/dofek@sha256:d8ca75d14b4da18057f3cf43d34889adf3d65c4927caccee69a8cee34e8120a1`.
Its [CI](https://github.com/Asherlc/dofek/actions/runs/42437851169) and
[image build](https://github.com/Asherlc/dofek/actions/runs/42437849237) passed.
Later preparation commits change documentation only. Any runtime change requires
a newly verified image and a revised proposal.

Only the broker and application services participating in this release should
change. Keep Postgres, ClickHouse, PeerDB, Redis, the collector and unrelated
service specifications unchanged. In particular, the tested deletion repair
does not authorize upgrading production ClickHouse from 26.6 to 26.10.
Leave Deploy Web disabled throughout the transition. Do not run a full-stack
deployment or use `--prune` as a shortcut.

Production census during preparation:

- Web has two replicas; worker has one. No training-export-worker service exists.
- Three ClickHouse sinks and three archive services each have one replica.
- Analytics-worker, processing-reconciliation and cdc-health each have one replica.
- All application services except the repaired history sink still use the old
  `b5676e56…` image. The history sink already uses the qualified image on Redpanda.
- Archives currently reference `dofek_metric_stream_r2_archive_config_v5`;
  the committed v6 Connect configuration uses `KAFKA_BROKERS`.
- The history backlog is [fully recovered](../../docs/evidence/history-clickhouse-recovery-20261108/README.md).
  This proposal does not repeat the historical identity scans.
- A read-only, five-second-limited Postgres aggregate returned zero open
  account-erasure requests and zero requests with identifying/unconverted fields.
  This is a preparation observation, not a guarantee about the maintenance window.

The source-image journal comparison adds migrations
`0178_native_metric_stream_delivery` and `0179_account_erasure_identifiers`.
Migration 0179 explicitly rejects retained identifiers/unconverted requests.
Run the existing migration command after quiescence; never bypass that guard.
The separate [native transport gate](../../docs/account-erasure-runbook.md#native-transport-cutover-gate)
also requires zero open requests.

## Before requesting execution approval

Preparation receipt: the private proposed v2 environment passed the existing
service-environment renderer. Required credentials were present. Comparing key
names against the current services found the expected `KAFKA_BROKERS` addition
and `METRIC_STREAM_TRANSPORT_EPOCH` entries for sink/archive routes, with no
other added key names. A Kafka-only specification extracted from the committed
service passed `docker stack config`, attached to external `dofek_default` and
included no application/database service. No service was created or updated.
These observations do not replace the final paused-writer checks.

Prepare and review these operator artifacts privately, without printing secrets:

1. A Kafka-only Swarm specification copied from the committed Kafka service,
   using its pinned image, plugin checksums, environment and 2048 MiB limit.
   It must attach to the existing `dofek_default` overlay network. Validate it
   with `docker stack config`; it must contain no application or database service.
2. Least-privilege service environment files from the existing
   `render-deploy-service-env.ts` path, with all three v2 route names. Compare
   required key names with each current service; resolve missing prerequisites
   before downtime. Never display values or save them in this document.
3. Exact, digest-pinned, zero-replica updates for the application services below,
   including archive configuration replacement from the committed Connect file.
   Preserve unrelated service options. Update canonical broker/topic environment
   entries and remove the old broker key; do not retain an alias fallback.
   Use `docker service update --replicas 0 --image <pinned-image>` with
   `--env-add` for the reviewed assignments and `--env-rm REDPANDA_BROKERS`.
   Docker service update has no `--env-file` option; pass each assignment as a
   separately quoted argument in the private operator session, without logging
   arguments. Preserve existing inline database URLs, secret mounts and routing
   labels. The three archive services keep their Connect image and receive the
   reviewed environment/configuration update instead of the application image.
   Create `dofek_metric_stream_r2_archive_config_v6` from
   `deploy/redpanda/metric-stream-r2-archive.connect.yml` using stock
   `docker config create` if absent. An existing v6 object must match the source
   bytes before reuse. While each archive is at zero replicas, remove its v5
   reference and add v6 at `/connect/metric-stream-r2-archive.connect.yml`, mode
   `0444`. Retain the old config object for a reviewed pre-write reversal.
4. The existing release steps needed for web-asset upload, database migrations,
   CDC compatibility and image verification, extracted from
   [Deploy Web Stack](../../.github/workflows/deploy-web-stack.yml).
   These are required even though the complete workflow cannot sequence this
   cutover safely. Record their exact commands before requesting execution.
5. A private snapshot of the prior service specifications, replica targets,
   topic values and broker settings. Print only sanitized summaries. Review
   schema rollback compatibility separately from broker rollback.

**This proposal is not execution-ready until those artifacts are validated.**
A written phase order alone does not authorize a production command.

## Maintenance sequence

### 1. Pause writers; retain readers for drain

After explicit cutover approval, capture the current census and desired replica
counts. Pause the deployed request and background producers:

```sh
docker service scale dofek_web=0 dofek_worker=0
```

If the fresh census contains another producer, include it explicitly before
continuing. Confirm actual running tasks have exited, not merely desired zero.
This is application downtime, including API/account-erasure request creation.
Do not reapply a stack specification that restores these replicas.

Keep the six metric-stream sink/archive consumers running until all six groups
have zero lag and the old main/quarantine topic high-water marks are stable.
Record offsets, topic names and archive object metadata. Archive consumer lag
alone does not prove a remote object exists. Do not fetch archive bodies.

### 2. Quiesce the remaining release services

After the drain, stop old consumers and application background readers:

```sh
docker service scale \
  dofek_metric-stream-clickhouse-sink=0 \
  dofek_metric-stream-live-clickhouse-sink=0 \
  dofek_metric-stream-history-clickhouse-sink=0 \
  dofek_metric-stream-r2-archive=0 \
  dofek_metric-stream-live-r2-archive=0 \
  dofek_metric-stream-history-r2-archive=0 \
  dofek_analytics-worker=0 \
  dofek_processing-reconciliation=0 \
  dofek_cdc-health=0
```

Verify actual task termination and relevant database/query quiescence using
the existing migration release checks. Recheck the native transport and 0179
aggregate gates with request producers and workers stopped. A nonzero count
blocks the release; do not convert or delete request data during this cutover.

### 3. Stop Redpanda, start only Kafka, provision topics

```sh
docker service scale dofek_redpanda=0
```

Verify no running broker task. Keep `/mnt/dofek-data/redpanda` intact.
Provision the pinned plugin pair and new Kafka directory using the existing
release commands. Deploy only the validated Kafka specification, without
`--prune`; do not apply the complete target stack.

Use an external stock Kafka CLI container for broker API readiness and topic
provisioning, as in the existing workflow. Create and describe these three
topics and each matching `.quarantine.v1` topic:

| Route | New topic |
|---|---|
| Legacy | `metric-stream-v2` |
| Live | `metric-stream-live-v2` |
| History | `metric-stream-history-v2` |

Require one partition/RF1, remote storage enabled, delete cleanup, total retention
7 days/1 GiB, segments 32 MiB/1 hour and local retention 256 MiB. These are the
already qualified settings, not a hard local-disk ceiling. Describe and compare
every required setting. Do not regenerate the provisioned cluster ID.

### 4. Apply release prerequisites and update stopped applications

After explicit approval for global topic edits, set all three Infisical route
values to the v2 names above and use `KAFKA_BROKERS=kafka:9092`. Re-render the
reviewed service environment files. Keep JSONL archive credentials/bucket
separate from Kafka tiered storage.

Upload the release's web assets, run the canonical one-shot migrations and
required CDC release checks. If migration 0179 fails, keep writers stopped and
report the first fatal error; do not restore old applications on an assumed
compatible schema.

Apply the reviewed application image/environment/configuration updates while
each affected service still has zero replicas. Verify image provenance and
topic/broker names without dumping the service environment. Apply no database
engine upgrade and no unrelated infrastructure reconciliation.

### 5. Start readers, then writers

Restore the three sinks and three archives to their recorded targets first.
Require actual healthy tasks, consumer attachment to the correct v2 topics and
no substantive startup/configuration errors. Confirm the archive configuration
uses the canonical broker key. Restore other application background services
only after their schema/CDC prerequisites pass.

Restore worker and web last, to the recorded replica counts. The first successful
Kafka publication is the forward-only broker boundary. Observe new offsets,
serving/archive progress, Kafka R2 segment copies, memory and disk. A brief
empty-topic health pass does not establish successful production delivery.
Remote reads and physical remote deletion need their own observed evidence;
do not claim them from zero lag or from the lab qualification.

## Failure boundaries

- Before any production Kafka write, a broker reversal requires stopping new
  consumers, verifying no writes, restoring prior topic/broker values and
  restoring the recorded Redpanda service. Application/schema rollback is a
  separate compatibility decision. Never blindly roll every service back.
- After any production Kafka write, stop affected writers if necessary and
  investigate forward. No automatic return to Redpanda, replay, manual
  acknowledgement, offset reset or dual-write is authorized.
- A failed migration keeps request producers and old workers stopped until a
  compatible recovery is approved.
- Old Redpanda data deletion and re-enabling Deploy Web require separate approval.

Docker documents [service scaling](https://docs.docker.com/reference/cli/docker/service/scale/),
[service updates](https://docs.docker.com/reference/cli/docker/service/update/) and
[stack deployment/pruning](https://docs.docker.com/reference/cli/docker/stack/deploy/).
Use those stock mechanisms; no new maintained cutover tool is needed.
