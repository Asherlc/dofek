# Kafka runtime (agents)

Read [`README.md`](./README.md) and
[`docs/kafka-tiered-storage-assessment.md`](../../docs/kafka-tiered-storage-assessment.md)
(current plan) before changing broker/plugin/compose wiring.

- **This lane:** compose/stack/plugin host publish only — no `src/**` edits.
- **B7:** app `KAFKA_BROKERS`, topic v2 defaults, erasure including Kafka TS cold objects.
- No operator Java in broker healthchecks; no custom broker image.
