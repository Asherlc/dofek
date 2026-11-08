# Kafka broker instructions

Read [README.md](./README.md) before changing broker wiring or activation notes.

- Preserve existing application and Connect `REDPANDA_BROKERS` contracts and the
  repaired history image's existing `KAFKA_BROKERS` contract.
- Kafka WITH tiered storage is required. The checked-in hot-log alternative is
  withdrawn, not deployable; do not flip its remote-storage flag while its worker
  still requires remote storage disabled. See the current boundary in
  [qualification.md](qualification.md#tiered-storage-required-quiescence-review).
- Keep the original Redpanda root in place for the read-only completion hold;
  do not stage an empty replacement directory or move retained bytes outside it.
- Keep the broker slice independent of the unrelated erasure redesign.
- Prefer the pinned stock Kafka image and upstream tiered-storage plugin. Do not
  implement a new runtime approach or custom broker/plugin before the storage
  finality requirement and any necessary strategy approval are resolved. See the
  pinned [source review](qualification.md#tiered-storage-required-quiescence-review).
- Keep operator JVMs outside the broker cgroup.
