# Kafka tiered-storage candidate

This is the **tiered-storage layer**, following the merged
[Kafka migration PR #3233](https://github.com/Asherlc/dofek/pull/3233).
This layer owns upstream
Aiven/R2 configuration, remote deletion verification and tiered qualification;
it extends the existing broker guard rather than duplicating it.

**Phase 2: tiered storage after Kafka deployment.** The user's latest explicit
order is Kafka first through PR #3233, then this separately approved tiered
release. The [phase-1 approval](phase1-approval.md) and
[completed execution receipt](phase1-execution.md) record the Kafka-only scope;
Kafka is now live. That approval does not authorize a repeat cutover or tiered
activation. The [shared application release proposal](shared-release.md) records
its separate image and deployment boundaries. Upstream Aiven remains selected for phase 2;
there is no plugin fork. This phase must preserve the phase-1 data, cluster/topic
generations, offsets and archive identities. Existing fresh-tiered fixture proof
does not alone qualify enabling tiering on an existing phase-1 broker.

## Intended configuration

[`../stack.yml`](../stack.yml) uses the pinned Apache Kafka 4.4.0 image and
upstream Aiven 1.2.0 core/S3 artifacts. Broker remote storage is enabled. Keep the
already qualified [plugin provenance/checksums](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-lab-20261106/plugin-provenance.json)
and original `hostname: kafka` fix. Operator JVMs run outside the broker cgroup.
See [Kafka tiering](https://kafka.apache.org/44/operations/tiered-storage/) and
the [Aiven release](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0).

The existing phase-1 host data path is `/mnt/dofek-data/kafka-broker/data`, mounted at
`/var/lib/kafka/data` in Kafka and read-only at `/var/lib/dofek/kafka-data` in the
worker. Plugins remain read-only at `/mnt/dofek-data/kafka/plugins/1.2.0/{core,s3}`.
The phase-1 operation provisioned the data directory; normal deployments only
validate existing paths and the mounted data filesystem. See the
[execution receipt](phase1-execution.md).
Keep original Redpanda `/mnt/dofek-data/redpanda` and aborted Kafka
`/mnt/dofek-data/kafka/data` in place; the worker holds completion while either
read-only retired root has any entry. No tree is moved, reused, formatted or
deleted by this candidate. Managed R2/Terraform resources remain declared and
protected in [`../kafka-ts-r2-offload.tf`](../kafka-ts-r2-offload.tf).

The existing [environment renderer](../../scripts/deploy-service-environment.ts)
supplies both broker and worker from `KAFKA_CLUSTER_ID` and the five existing
`KAFKA_TIERED_STORAGE_{BUCKET,ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`
contracts. The broker receives native S3/AWS names; the worker keeps the original
names. **The object prefix is derived from the same cluster ID as `<clusterId>/`
in both consumers of this configuration.** No independent prefix flag is added.
The dedicated Kafka credentials/bucket remain separate from the JSONL archive.

Kafka Admin redacts RSM bucket/endpoint/prefix values. Before release, verify the
actual consumed broker and worker endpoint, bucket, prefix, region and credential
scope with existing tooling, without printing secrets. Admin class/config checks
do not prove equality of those redacted inputs. This explicit deployment trust
boundary is required; see the [configuration API](https://kafka.apache.org/44/operations/basic-kafka-operations/#checking-configurations).

## Erasure boundary

The existing `retention_verification → assertBrokerStorageExpired` hook requires
all six source/quarantine generation checkpoints, covered local-file removal,
complete native metadata history through a captured cut of every partition,
terminal deletion of covered copy attempts, and complete object and multipart
enumeration under the generation prefix. Unknown schemas, truncated history,
incomplete listings, unexplained keys/cache entries, generation drift or retained
original broker bytes block completion. Native remote index files are included.
See [the source review and qualification](qualification.md).

**Accepted exception:** an earlier unknown-outcome remote upload may commit after
deletion and final verification, leaving an orphan indefinitely. The user
accepted that specific residual, including indefinite retention. It is not a
general waiver of erasure checks, an observed incident or a measured frequency.
R2 documents the [in-flight-write ordering](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).
Orphans remain listable by native topic/generation/partition/segment keys; they
are not indexed by user. Manual cleanup requires separate scope and approval.
The [stronger custom fencing proposal](tiered-fencing-proposal.md) is not selected.

## Release gates

Preserve existing application/Connect `REDPANDA_BROKERS`, the repaired history
image's `KAFKA_BROKERS`, all current consumer routes and ClickHouse 26.6. Release
the narrowly changed worker as a separately qualified image; the historical
hot-log worker image does not qualify this runtime. Combining PR #3234 must
explicitly preserve the broker hook and all six structural checkpoint fields.

The [cutover packet](cutover-packet.md) and [operator command record](operator-proposal.md)
retain the executed phase-1 boundaries. The [phase-2 reference](tiered-cutover-packet.md)
requires a separately reviewed transition preserving the existing data and
cluster/topic identities; its historical fresh-bootstrap commands are not
phase-2 instructions. Main-branch CI can trigger application deployment, so
tiered source landing and activation require one reviewed release sequence.
The normal workflow requires Kafka already active; it is not the first cutover.

The pinned worker's [actual phase and remote-read/restart evidence](../../docs/evidence/kafka-tiered-child-20261108/README.md)
is complete for the isolated fixture. Production consumed configuration, retention
policy, measured capacity/headroom, old-data disposition, full application release
qualification and cross-branch scrub integration remain gates. RF1/asynchronous
offload cannot guarantee zero data loss after irreversible loss of the only disk;
local retention is not a hard disk ceiling while offload is failing. The JSONL
archive is retained, but [operator-ready replay is not shipped](../../docs/metric-stream-redpanda-r2-runbook.md#replay).
No production changes, credential edits, retirement or cloud experiments are
authorized by this offline candidate.
