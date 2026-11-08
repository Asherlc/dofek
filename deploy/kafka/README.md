# Kafka broker candidate

This branch extracts the broker candidate from frozen
[PR #3231](https://github.com/Asherlc/dofek/pull/3231), commit `ed26f38b8`.
It does not authorize or perform activation. Production remains on Redpanda.

## Runtime contract

The broker stanza in `../stack.yml` uses stock Apache Kafka 4.4.0 with the
qualified Aiven 1.2.0 core/S3 plugin pair. Plugins are checksum-verified and
published as a versioned directory by the normal deploy workflow. The broker
uses its own data directory and native `hostname: kafka`; operator JVMs run
outside its memory limit. See the [Kafka release](https://kafka.apache.org/blog/2026/10/22/apache-kafka-4.4.0-release-announcement/)
and [Aiven plugin](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka).

`scripts/deploy-service-environment.ts` renders a private `kafka.env` from
`KAFKA_CLUSTER_ID` and the five `KAFKA_TIERED_STORAGE_*` keys. Existing
applications, ClickHouse sinks and Connect archives retain `REDPANDA_BROKERS`.
Changing the endpoint is an explicitly approved activation action, not a
variable-name migration. The Connect v5 config, existing application image
contracts, Postgres journals and ClickHouse 26.6 are retained.

Dedicated R2 resources and their Infisical bindings are in
[`../kafka-ts-r2-offload.tf`](../kafka-ts-r2-offload.tf). The bucket has no live
object age expiry; Kafka owns remote retention. This is separate from the
JSONL archive. See [Kafka tiered storage](https://kafka.apache.org/44/operations/tiered-storage/)
and [R2 token credentials](https://developers.cloudflare.com/r2/api/tokens/).

## Activation prerequisites

**Remote physical erasure is a real unresolved activation dependency.**
The existing `assertAccountErasureReplayExpired` in
`src/account-erasure/redpanda-drain.ts` compares the current low offset to
captured offsets. It does not verify physical remote-object removal. Do not
certify tiered-storage erasure from that check or import the unrelated account
snapshot/catalog/identifier redesign to make this PR appear independent.
Kafka remote deletion is asynchronous; see the
[tiered-storage deletion design](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage).

Normal application deployment now requires an already active Kafka service and
rejects an active Redpanda service before deployment mutations. It verifies
broker API readiness and the three configured source topics and quarantine
topics before the normal application release. It does not perform initial
topic creation, change offsets, or choose a new topic generation.

Before activation, a fresh broker-only packet must resolve and record:

1. Narrow remote-erasure compatibility and its executable evidence.
2. Current immutable image references for each service, including the separately
   repaired history sink; do not collapse these into one `APP_IMAGE`.
3. Writer pause/drain boundaries and all six consumer/archive routes, their
   source topics and committed offsets on the old cluster.
4. Explicit new-cluster topic identity and archive-key collision prevention.
   Kafka cluster offsets restart independently; do not reuse archive identities
   without proving they cannot overwrite old objects.
5. Topic creation/configuration on the isolated new broker, including source
   and quarantine retention, followed by current-image real-engine qualification.
6. Reversal before the first Kafka write, forward recovery after it, retained
   Redpanda data, and final image/route/lag evidence.

Use stock [Swarm service operations](https://docs.docker.com/reference/cli/docker/service/update/)
for a separately approved broker-only cutover. Do not use the full-stack
application release, pruning, old cutover scripts, or old maintenance approval
for that first activation. This document is a qualification checklist, not an
executable cutover packet.

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
