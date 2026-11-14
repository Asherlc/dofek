# Kafka tiered storage

This is the **tiered-storage layer**, following the merged
[Kafka migration PR #3233](https://github.com/Asherlc/dofek/pull/3233).
This layer owns upstream
Aiven/R2 configuration, remote deletion verification and tiered qualification;
it extends the existing broker guard rather than duplicating it.

The [phase-1 approval](phase1-approval.md) and
[completed execution receipt](phase1-execution.md) record the Kafka-only scope;
Kafka is live. PR [#3236](https://github.com/Asherlc/dofek/pull/3236) merged
the tiered-storage runtime. The Nov 12 [broker audit](retention-policy.md)
observed upstream Aiven RemoteStorageManager, a generated Cloudflare R2 endpoint,
remote storage enabled on all six topics, and successful copy/delete in its
bounded log sample. This does not establish the exact activation date. Upstream
Aiven is the selected tiered backend; there is no plugin fork. Preserve the
phase-1 data, cluster/topic generations, offsets and archive identities. The
[existing-broker local transition](../../docs/evidence/kafka-tiered-transition-20261109/README.md)
qualifies native remote replay with synthetic data.

The [shared application release proposal](shared-release.md) records the reviewed
image, deployment effects and remaining decisions before merging this PR.
That release is recorded in the [execution receipt](shared-release-execution.md):
the workflow and live health checks passed, with a separately documented
quarantine topic-configuration defect.
The [deploy-owned topic policy](quarantine-config-correction.md) describes the
incremental reconciliation and readback before and after consumer startup. The
audit observed both local retention settings at `-2` (inherit total limits).
The explicit local limits in [`topic-policy.json`](topic-policy.json) were
subsequently applied by the canonical release. Independent readback and fresh
remote-only reads after local eviction are recorded in the
[production observation](retention-policy.md#production-observation-november-12-november-13-utc).
Verify effective values through each release's readbacks rather than treating
the earlier audit as current policy.

## Intended configuration

[`../docker-compose.yml`](../docker-compose.yml) uses the pinned Apache Kafka 4.4.0 image and
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
deleted by the tiered-storage rollout. Managed R2/Terraform resources remain declared and
protected in [`../kafka-ts-r2-offload.tf`](../kafka-ts-r2-offload.tf).
The operator separately authorized [Redpanda cleanup](retention-policy.md#retired-redpanda-cleanup)
on November 12: its contents are now removed, while the original directory and
read-only mount remain. The aborted Kafka tree is still retained.

The existing [environment renderer](../../scripts/deploy-service-environment.ts)
supplies both broker and worker from `KAFKA_CLUSTER_ID` and the five existing
`KAFKA_TIERED_STORAGE_{BUCKET,ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`
contracts. The broker receives native S3/AWS names; the worker keeps the original
names. **The object prefix is derived from the same cluster ID as `<clusterId>/`
in both consumers of this configuration.** No independent prefix flag is added.
The dedicated Kafka credentials/bucket remain separate from the JSONL archive.

For every release, verify the actual consumed broker and worker endpoint,
bucket, prefix, region and credential scope privately through the canonical
workflow, without printing secrets. Kafka Admin redacts RSM bucket/endpoint/
prefix values, and class/config checks do not establish equality of those
redacted inputs. The Nov 12 audit checked the broker's generated R2 endpoint
and RSM class/config; it did not establish all broker/worker values match. See
the [configuration API](https://kafka.apache.org/44/operations/basic-kafka-operations/#checking-configurations)
and [audit record](retention-policy.md).

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

Preserve the completed shared release's `REDPANDA_BROKERS` contract for all
application and Connect services, all current consumer routes and ClickHouse 26.6.
The old phase-1 history image used `KAFKA_BROKERS`; see the
[current service receipt](../../docs/evidence/kafka-shared-production-release-20261109/contracts.json). Release
the narrowly changed worker as a separately qualified image; the historical
hot-log worker image does not qualify this runtime. Combining PR #3234 must
explicitly preserve the broker hook and all six structural checkpoint fields.

The [cutover packet](cutover-packet.md) and [operator command record](operator-proposal.md)
retain the executed phase-1 boundaries. The [phase-2 reference](tiered-cutover-packet.md)
contains historical transition instructions; its fresh-bootstrap commands are
not instructions for the already active production cluster. Use the canonical
workflow for reviewed application releases and topic-policy reconciliation.

See official [Kafka tiered-storage documentation](https://kafka.apache.org/44/operations/tiered-storage/)
and the [topic configuration reference](https://kafka.apache.org/44/configuration/topic-configs/).
The historical [packaged remote-read/restart evidence](../../docs/evidence/kafka-tiered-child-20261108/README.md)
and current [workspace retention-phase evidence](../../docs/evidence/kafka-tiered-transition-20261109/README.md)
have distinct attribution and limits. Production consumed configuration, retention
policy, measured capacity/headroom, old-data disposition, full application release
qualification and cross-branch scrub integration remain gates. RF1/asynchronous
offload cannot guarantee zero data loss after irreversible loss of the only disk;
local retention is not a hard disk ceiling while offload is failing. The JSONL
archive is retained, but [operator-ready replay is not shipped](../../docs/metric-stream-redpanda-r2-runbook.md#replay).
No production topic changes, credential edits, retirement or cloud experiments
are authorized by this documentation update.

The [existing-broker transition](../../docs/evidence/kafka-tiered-transition-20261109/README.md)
also observed covered index-cache files surviving terminal remote deletion.
The erasure guard correctly blocks. A qualified stock cache-cleanup policy is
an erasure-completion blocker. Tiered activation has occurred, but this cleanup
risk remains unresolved. See the [phase-2 packet](tiered-cutover-packet.md#qualification-recovery-and-limits).
