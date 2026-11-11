# Kafka tiered-storage layer

Status: **November 9 review fixes and main integration pass local checks;
new branch CI pending. Production activation remains blocked**.
The user selected upstream Aiven and explicitly requested separate broker and
tiered-storage workspaces. The Kafka migration
([PR #3233](https://github.com/Asherlc/dofek/pull/3233)) is merged; reuse its
protocol integration, native local guard and structural fields.

The [November 9 review checkpoint](../evidence/kafka-tiered-transition-20261109/README.md)
records existing-data transition, remote reads/restart, actual workspace phase
tests, full local checks and a fresh independent review. Source landing relies
on the unchanged automatic-deployment hold. Stock index-cache cleanup, exact
release image and production backend/capacity/quiescence qualification remain
activation gates; synthetic cache removal does not close them.

## Owned changes

- Stock Apache Kafka 4.4.0 with upstream Aiven 1.2.0 enabled in the canonical
  stack. No plugin patch, per-user sharding, hot-log fallback or new framework.
- Existing environment renderer supplies broker/worker from the same cluster ID
  and dedicated Kafka R2 contracts. Prefix is `<clusterId>/` in both, with no new
  independent configuration key. The same fresh `/mnt/dofek-data/kafka-broker/data`
  host source is used by both source layers.
- Extend `KafkaLogStorage` and the existing actual worker retention hook with
  native terminal deletion, complete R2 object/multipart enumeration, remote
  index-cache checks and the preserved aborted-Kafka root hold. No broader
  snapshot/catalog/identifier erasure redesign is imported.
- Keep already-applied R2/Terraform declarations inherited from the parent to
  prevent accidental resource destruction. This branch adds no apply or deletion.

See [Kafka tiering](https://kafka.apache.org/44/operations/tiered-storage/),
[Aiven 1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0)
and the [native deterministic key layout](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java).

## Minimal adapter decision

KafkaJS handles broker protocol, record batching and supported compression; its
[public consumer API](https://kafka.js.org/docs/consuming) supplies the native value
but not Kafka's internal remote-log metadata decoder. A bounded search found no
suitable maintained JavaScript implementation. Kafka ships the
[stock native formatter](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/metadata/storage/serialization/RemoteLogMetadataSerde.java),
which can process multiple partitions in one JVM. Using it in production would
add a JRE, Kafka distribution and a child process to the Alpine Node worker;
the worker currently has a 512-MiB limit. Do not claim it requires 50 JVMs.

Use one narrowly pinned structural reader for Kafka 4.4's v0 admission/update
schemas, with native formatter parity as a qualification requirement. Unknown
record/frame/schema versions, tags, tombstones, gaps and incomplete histories
fail closed. No generic serialization library, extra topic, receipt store,
registry, permanent CLI or polling service is introduced. The history read has
explicit worker memory/time bounds and scans a captured cut of every partition.

## Qualification status and remaining work

1. Extracted runtime is wired through the existing worker hook. In this workspace,
   121 focused tests passed across six suites; TypeScript and focused lint passed.
   No CI result transfers from the parent or the withdrawn alternative.
2. Pre-split isolated six-topic stock observation: actual local/remote guard blocked after
   logical expiry while local files remained, then passed at 22:07:26 UTC after
   native cleanup, reading all 50 metadata partitions. Eighteen newer remote
   objects remained. Captured boundary was 200 on all six topics. This is a
   native lifecycle observation, not a power-loss/R2-cloud/forensic guarantee.
   The fixture was stopped and removed before workspace transfer.
3. Child-owned native cleanup, remote-only reads/restart and pinned worker-image
   retention-phase qualification passed. See the [exact source/image, chronological
   receipt and limits](../evidence/kafka-tiered-child-20261108/README.md).
   The actual native reader consumed all 50 partitions. Formatter parity reused
   the identical pinned decoder's two stock vectors, not an unrelated image proof.
4. Run appropriate source checks/CI and complete the tiered operator packet.
   Do not silently merge or activate either layer independently.

## Accepted residual and release gates

The user accepted an earlier unknown-outcome PUT committing after deletion/final
verification, including an orphan remaining indefinitely. This does not waive
ordinary object, multipart, metadata, local, original Redpanda or other erasure
checks. [R2 documents this ordering](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).

Admin redacts RSM bucket/endpoint/prefix. Existing tooling must verify actual
consumed broker/worker configuration and credential scope at release without
printing secrets; native terminal events do not prove backend scope equality.
Retain current application/Connect `REDPANDA_BROKERS`, repaired history
`KAFKA_BROKERS` and its pinned image, ClickHouse 26.6, existing archive and old data.

Merge/release sequencing needs explicit coordination because parent main CI can
deploy its local-only configuration. Retention/capacity, old-data disposition,
current-head CI and explicit six-field erasure scrub integration remain
gates. No production/cloud mutation, credential edit, data removal, merge,
deployment or new strategy is approved by the source split.

## Main synchronization and packet checkpoint

Main `afa8b6e46` adds the separately reviewed history/sample-identity repair.
Parent merge `eba115371` resolved only an append conflict in the incident log,
preserving both sets of records. Child synchronization has the same sole conflict;
no runtime hunk needed manual resolution. Parent's 134 focused tests and child's
232 focused tests passed, with root/server/web typechecks. The seven tiered
runtime receipt files still match the pinned `e19b92001` image; other main changes
are not retroactively included in that image.

The [canonical tiered packet](../../deploy/kafka/tiered-cutover-packet.md) replaces
hot-only command text with provenance links and records the remaining source
landing decision. Eight shell blocks passed syntax checks; intercepted Docker
arguments matched all 29 canonical broker environment values, shared backend/
prefix and worker mounts/entrypoint. Those checks invoked no Docker engine.

Review checkpoint: keep the pinned image qualification separate from merged-head
CI and any subsequent full-app image. The stock complete-graph landing proposal
is recorded for approval only; PR bases, triggers and production are unchanged.
