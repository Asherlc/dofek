# Kafka broker migration

This workspace/PR owns the **broker migration layer**. The separate
[`kafka-tiered-storage` workspace/branch](https://github.com/Asherlc/dofek/tree/kafka-tiered-storage)
owns upstream Aiven/R2 activation, remote deletion verification and tiered
qualification. That branch is stacked on this one so it reuses the existing
broker integration and structural checkpoints without duplicating them.

**Release order selected: Kafka first, tiered storage second.** The latest user
instruction makes this Kafka-only layer phase 1. Review the [single concrete
phase-1 approval](phase1-approval.md) and [completed execution receipt](phase1-execution.md).
Q4/A authorized the exact policy, pause, routes, first-write/recovery boundary and
observation; Kafka is now live. That completed approval does not authorize a
repeat cutover or the broader shared application release. The separate tiered candidate is phase 2; its accepted
late-upload/orphan residual does not weaken phase-1 checks.

The [shared application release proposal](shared-release.md) records the reviewed
image, deployment effects and remaining decisions before merging this PR.

## This layer

- Pinned stock Kafka 4.4.0 broker, native `hostname: kafka`, single broker/log
  directory and existing protocol-compatible application images.
- Existing `REDPANDA_BROKERS` contracts for applications/Connect; separately
  repaired history image keeps `KAFKA_BROKERS`. No application transport overhaul,
  migrations 0178/0179, erasure redesign or ClickHouse upgrade.
- Structural cluster/topic-generation checkpoints and the native local-file/
  retained-Redpanda completion guard. The tiered layer extends this same hook;
  the local-only guard does not certify remote deletion.
- API/topic readiness, environment rendering and reviewed broker-only release
  boundaries. Operator JVMs run outside the broker cgroup.

The fresh host source is `/mnt/dofek-data/kafka-broker/data`, mounted as
`/var/lib/kafka/data` in Kafka and read-only at `/var/lib/dofek/kafka-data` in the
worker. The tiered layer uses this same source, not another Kafka data tree.
The approved phase-1 operation created that fresh directory; normal application
deployment now only validates existing paths and the mounted data filesystem.
Original Redpanda `/mnt/dofek-data/redpanda` and aborted Kafka
`/mnt/dofek-data/kafka/data` remain preserved.

The base broker configuration has remote storage disabled because the plugin
and remote verifier belong to the dependent tiered layer. This is the selected
first stage, not the final storage architecture. See
[Kafka's tiered-storage configuration](https://kafka.apache.org/44/operations/tiered-storage/).

Already-managed R2/Terraform declarations remain here solely to preserve applied
resources. Removing them to make the file split look cleaner could schedule
destruction of existing buckets, credentials or bindings. No Terraform apply or
decommission is authorized; see [Terraform resource lifecycle](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle).

## Review and release boundary

Historical protocol/native proofs and image pins remain in
[qualification.md](qualification.md). Their passes do not transfer to the new
tiered runtime. Earlier combined tiering/fencing documents are historical context;
current remote implementation and qualification are owned by the dependent branch.

The [cutover packet](cutover-packet.md) and [operator command record](operator-proposal.md)
retain the executed first-stage boundaries. Main-branch CI can trigger application deployment, so the
two source layers need a coordinated merge/release sequence: merging a local-only
parent after tiered activation must not re-disable remote storage. No automation
change, merge, deployment, pause, topic mutation, credential edit, old-data
retirement or cloud experiment is authorized by the source split alone.
