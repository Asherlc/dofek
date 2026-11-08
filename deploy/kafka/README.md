# Kafka broker candidate

**Blocked: Kafka WITH tiered storage is the required objective.** The user
explicitly rejected advancing hot-log-only as the migration solution. The
checked-in tree still reflects that withdrawn alternative; its remote-disabled
broker and local-only worker guard are not a deployable tiered candidate. Do not
merge or activate it. Preserve its evidence, managed R2 resources and old data.
See the [bounded tiered review](qualification.md#tiered-storage-required-quiescence-review).
The user subsequently [accepted the narrow late-upload risk](tiered-fencing-proposal.md#accepted-exception-and-intended-stock-path).
Resume stock Kafka/Aiven tiered qualification; the custom write-fencing proposal
is not selected. The current remote-disabled tree still requires correction and
qualification before it represents that candidate.

This branch extracts the broker candidate from frozen
[PR #3231](https://github.com/Asherlc/dofek/pull/3231), commit `ed26f38b8`.
It does not authorize or perform activation. Production remains on Redpanda.

## Current tree: withdrawn hot-log alternative

The canonical broker stanza in `../stack.yml` uses stock Apache Kafka 4.4.0 as
a hot log, with remote storage explicitly disabled. There is no alternate overlay
to remember and no RSM plugin or credential in the broker service. The normal
deployment applies this same base configuration. See the
[Kafka release](https://kafka.apache.org/blog/2026/10/22/apache-kafka-4.4.0-release-announcement/)
and [broker configuration](https://kafka.apache.org/44/configuration/broker-configs/).

The candidate uses the fresh host path `/mnt/dofek-data/kafka-hot-log/data`,
mounted at `/var/lib/kafka/data` in the broker and read-only at
`/var/lib/dofek/kafka-data` in the worker. It does not reuse, move or delete the
aborted tiered broker tree at `/mnt/dofek-data/kafka/data`. The native
`hostname: kafka` is retained; operator JVMs run outside the broker memory limit.

`scripts/deploy-service-environment.ts` renders a private `kafka.env` from
`KAFKA_CLUSTER_ID` only, renamed to the stock image's `CLUSTER_ID`. Existing
applications, legacy/live ClickHouse sinks and Connect archives retain
`REDPANDA_BROKERS`. The separately repaired history image already requires
`KAFKA_BROKERS`; preserve its contract too. See the actual-image
[qualification record](qualification.md).
Changing the endpoint is an explicitly approved activation action, not a
variable-name migration. The Connect v5 config, existing application image
contracts, Postgres journals and ClickHouse 26.6 are retained.

The existing JSONL archive is retained; it does not provide transparent Kafka
remote reads or a demonstrated operator restore. The [canonical replay runbook](../../docs/metric-stream-redpanda-r2-runbook.md#replay)
states that bounded replay is not shipped. See the [archive configuration](../redpanda/metric-stream-r2-archive.connect.yml)
and [qualification limits](hot-log-qualification.md). Already-managed tiered R2
resources and Infisical bindings remain declared in
[`../kafka-ts-r2-offload.tf`](../kafka-ts-r2-offload.tf), pending separate
decommission approval. This branch must not schedule their destruction; see
[Terraform lifecycle protection](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle#prevent_destroy).

## Activation prerequisites

The old offset check is insufficient for physical file removal. The narrow
worker release adds the [native storage guard](../../src/account-erasure/kafka-log-storage.ts)
to actual retention completion, verifies structural cluster/topic generations,
and blocks while any entry remains in the read-only original Redpanda root.
See the [native proof and its limits](hot-log-qualification.md). The unresolved
tiered-copy fencing guarantee is avoided by the canonical hot-log configuration,
not asserted to have been solved.

Normal application deployment now requires an already active Kafka service and
rejects an active Redpanda service before deployment mutations. It verifies
broker API readiness and the three configured source topics and quarantine
topics before the normal application release. It does not perform initial
topic creation, change offsets, or choose a new topic generation.

Before activation, a fresh broker-only packet must resolve and record:

1. The digest-pinned narrow worker image, native mount checks and old-generation
   request preflight. Missing historical generation fields remain fail-closed.
2. Current immutable image references for each service, including the separately
   repaired history sink; do not collapse these into one `APP_IMAGE`.
3. Writer pause/drain boundaries and all six consumer/archive routes, their
   source topics and committed offsets on the old cluster.
4. Explicit new-cluster topic identity and archive-key collision prevention.
   Kafka cluster offsets restart independently; do not reuse archive identities
   without proving they cannot overwrite old objects.
5. Explicit hot-log topic creation/configuration, disk capacity and retention
   policy margin. Six 1 GiB targets are not a hard disk ceiling.
6. Reversal before the first Kafka write, forward recovery after it, retained
   Redpanda data, and final image/route/lag evidence.

Use stock [Swarm service operations](https://docs.docker.com/reference/cli/docker/service/update/)
for a separately approved broker-only cutover. Do not use the full-stack
application release, pruning, old cutover scripts, or old maintenance approval
for that first activation. The [cutover packet](cutover-packet.md) records current
digests and ordered boundaries. Its stop gates must be closed before final
production mutation commands are reviewed.

## Evidence ownership

The frozen source's [plugin provenance](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-lab-20261106/plugin-provenance.json),
[dual512 qualification](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-dual512-fix-20261106/CORE_PROOF.json),
and [aborted cutover receipt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-cutover-attempt-20261108/README.md)
remain historical records. Reuse only evidence for identical inputs. These
records do not qualify unchanged deployed clients against this extracted tree.

History-sink identity fixes, general CI/development documentation and retired
Pulsar cleanup are separate residual work. Application Kafka naming changes,
native publisher changes and migration 0178 transport acknowledgements are
deferred rather than required by the Kafka protocol transition.
