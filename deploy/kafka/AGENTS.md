# Kafka broker instructions

Read [README.md](./README.md) before changing broker wiring or activation notes.

- Preserve existing application and Connect `REDPANDA_BROKERS` contracts and the
  repaired history image's existing `KAFKA_BROKERS` contract.
- The canonical candidate is hot-log-only. See the qualified scope and native
  lifecycle sources in [hot-log-qualification.md](hot-log-qualification.md).
- Keep the original Redpanda root in place for the read-only completion hold;
  do not stage an empty replacement directory or move retained bytes outside it.
- Keep the broker slice independent of the unrelated erasure redesign.
- Use the pinned stock Kafka image; no custom broker image or RSM plugin.
- Keep operator JVMs outside the broker cgroup.
