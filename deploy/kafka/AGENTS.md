# Kafka broker instructions

Read [README.md](./README.md) before changing broker wiring or activation notes.

- Preserve existing application and Connect `REDPANDA_BROKERS` contracts.
- Do not activate tiered storage without resolving remote physical erasure.
- Keep the broker slice independent of the unrelated erasure redesign.
- Use the stock Kafka image and checksum-qualified plugin pair; no custom image.
- Keep operator JVMs outside the broker cgroup.
