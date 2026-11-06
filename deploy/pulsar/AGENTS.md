# Pulsar configuration

Read [README.md](./README.md) and [../README.md](../README.md) first.

- This directory currently supports isolated qualification, not an approved
  production cutover. Follow the acceptance gates in the linked plan.
- Qualification uses the pinned official `apachepulsar/pulsar:5.0.1` image and
  its bundled tiered-storage offloader NAR. Do not reintroduce a custom
  Dockerfile, patch, or source-build publish workflow. Apache documents the
  [Docker image](https://pulsar.apache.org/docs/5.0.x/deploy-docker/) and
  [tiered storage / offload](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/).
- Production Pulsar configuration (including offload endpoints and credentials)
  is reviewed and Infisical-provisioned separately from Compose qualification;
  do not add unprovisioned runtime env vars here.
- Keep Pulsar and BookKeeper metadata in separate Oxia namespaces. Persist both
  Oxia server state and coordinator Raft state; do not substitute the developer
  standalone mode when validating the production-shaped topology.
- Use schema/CLI validation for static configuration, not tests that mirror YAML.
- Do not claim durability against disk loss from single-node restart tests.

Apache documents the [metadata-store responsibilities](https://pulsar.apache.org/docs/5.0.x/administration-zk-bk/)
and Oxia documents its [component deployment](https://oxia-db.github.io/docs/deployment/bare-metal).
