# Kafka broker instructions

Read [README.md](./README.md) before changing broker wiring or activation notes.

- This workspace owns broker migration only. Remote plugin/R2 configuration,
  native remote deletion/object/multipart verification and tiered qualification
  belong to the separate `kafka-tiered-storage` workspace, stacked on this branch.
- The user selected upstream Aiven after the adoption discussion. Earlier
  rejection notes are historical. Do not reimplement tiering here or treat the
  source split as approval of standalone hot-log activation. See [README.md](./README.md).

- Preserve existing application and Connect `REDPANDA_BROKERS` contracts and the
  repaired history image's existing `KAFKA_BROKERS` contract.
- Kafka WITH tiered storage is the final objective. Do not flip this layer's
  remote-storage flag independently of the dependent worker verifier. See
  [qualification.md](qualification.md#tiered-storage-required-quiescence-review).
- Keep the original Redpanda root in place for the read-only completion hold;
  do not stage an empty replacement directory or move retained bytes outside it.
- Keep the broker slice independent of the unrelated erasure redesign.
- Prefer the pinned stock Kafka image; the upstream plugin belongs to the next layer. Do not
  implement a new runtime approach or custom broker/plugin before the storage
  finality requirement and any necessary strategy approval are resolved. See the
  pinned [source review](qualification.md#tiered-storage-required-quiescence-review).
- Keep operator JVMs outside the broker cgroup.
