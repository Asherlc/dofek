# Kafka broker instructions

Read [README.md](./README.md) before changing broker wiring or activation notes.

- This workspace owns tiered storage after the merged Kafka migration.
  Reuse the existing protocol integration, image contracts and structural checkpoints.
  Keep the common `/mnt/dofek-data/kafka-broker/data` host source; no data-tree move.
  See [README.md](./README.md).

- Preserve all current application and Connect `REDPANDA_BROKERS` contracts;
  see the [completed shared release](shared-release-execution.md). The old
  phase-1 history image's `KAFKA_BROKERS` contract is historical.
- Kafka WITH upstream Aiven tiered storage is the selected direction. Keep the
  single canonical broker/worker configuration coherent; no hot-log fallback or
  custom fencing plugin. See the accepted residual and release gates in
  [qualification.md](qualification.md#tiered-storage-required-quiescence-review).
- Keep the original Redpanda root in place for the read-only completion hold;
  do not stage an empty replacement directory or move retained bytes outside it.
- Keep the broker slice independent of the unrelated erasure redesign.
- Prefer the pinned stock Kafka image and upstream tiered-storage plugin. Do not
  implement a new runtime approach or custom broker/plugin. The user accepted the
  late unknown-outcome upload/orphan residual, not a general deletion waiver. See the
  pinned [source review](qualification.md#tiered-storage-required-quiescence-review).
- Keep operator JVMs outside the broker cgroup.
