# Pulsar qualification configuration

This directory contains the local single-server qualification topology's Oxia
configuration. It is not wired into the production Swarm stack. The approved
[design](../../docs/superpowers/specs/2026-11-03-single-server-pulsar-design.md)
and [implementation plan](../../docs/superpowers/plans/2026-11-03-single-server-pulsar.md)
define production acceptance gates.

The [qualification evidence](../../docs/pulsar-qualification.md) records failed
actual-R2 upload and whole-host resource gates. The local S3 stand-in passing
does not qualify Cloudflare R2, and these services must not be copied into the
production stack until those gates pass.

Oxia uses one data server and one Raft coordinator, with separate `pulsar` and
`bookkeeper` namespaces. Both processes have persistent state. Replication factor
one does not protect against loss of the sole disk. The coordinator configuration
uses the current `--sconfig` interface, not the deprecated `--cconfig` flag:
[Oxia deployment](https://oxia-db.github.io/docs/deployment/bare-metal),
[versioned coordinator interface](https://github.com/oxia-db/oxia/blob/v0.18.0/cmd/coordinator/cmd.go).

On a fresh workspace, start the metadata services through the workspace wrapper:

```bash
pnpm compose -- -f docker-compose.yml -f docker-compose.pulsar.yml --profile pulsar up -d pulsar-oxia-coordinator
```

Use the packaged `oxia admin --admin-address localhost:6650` CLI inside
`pulsar-oxia-coordinator` to register data server `pulsar-oxia` with public address
`pulsar-oxia:6648` and internal address `pulsar-oxia:6649`. Create namespaces
`pulsar` and `bookkeeper`, each with initial shard count and replication factor 1.
Use `dataserver get` and `namespace get` to inspect existing state rather than
recreating or resetting it. Raft mode stores configuration through the admin API;
a file-provider cluster YAML is not a Raft bootstrap mechanism. See the
[versioned admin commands](https://github.com/oxia-db/oxia/tree/v0.18.0/cmd/admin).

Before the first bookie start, format **only the fresh local qualification**
BookKeeper namespace through `pulsar-bookie`'s environment/configuration with
`bin/bookkeeper shell metaformat --nonInteractive`, without `--force`. This is
not a restart command: never format populated metadata. The native init tool is
documented in the [BookKeeper CLI reference](https://bookkeeper.apache.org/docs/reference/cli/).
Then run:

```bash
pnpm compose -- -f docker-compose.yml -f docker-compose.pulsar.yml --profile pulsar up -d --wait pulsar-broker
```

The Pulsar initializer explicitly uses the separate BookKeeper metadata URI;
the broker must use that same URI. The default initializer instead formats
BookKeeper under Pulsar's metadata URL:
[initializer source](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-broker/src/main/java/org/apache/pulsar/PulsarClusterMetadataSetup.java).
An idempotent, validated production bootstrap remains an implementation gate;
these explicit local initialization actions are not production deployment steps.

No ports are published to the host. Use `pnpm compose -- ... exec pulsar-broker`
for the packaged admin and client tools. Local JVM/cache budgets are qualification
inputs, not certified production capacity. The images include ARM64 manifests;
verify pinned releases again when updating:
[Pulsar releases](https://github.com/apache/pulsar/releases),
[Oxia releases](https://github.com/oxia-db/oxia/releases).

Stop these services without deleting their named volumes to test restart
recovery. Never remove production or another workspace's volumes during cleanup.
