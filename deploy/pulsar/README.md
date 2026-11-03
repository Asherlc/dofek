# Pulsar qualification configuration

This directory contains the local single-server qualification topology's Oxia
configuration. It is not wired into the production Swarm stack. The approved
[design](../../docs/superpowers/specs/2026-11-03-single-server-pulsar-design.md)
and [implementation plan](../../docs/superpowers/plans/2026-11-03-single-server-pulsar.md)
define production acceptance gates.

The [qualification evidence](../../docs/pulsar-qualification.md) records stock
R2 upload failures, a tested offloader correction, and the still-unqualified
whole-host resource gate. These services must not be copied into the production
stack until every required gate passes. The separate
[CDC assessment](../../docs/pulsar-cdc-assessment.md) does not authorize retiring
PeerDB.

The broker builds the existing Apache jclouds offloader from checksum-pinned
Pulsar 5.0.1 source with [a narrow payload-repeatability patch](repeatable-offload-payload.patch).
Its sealed-ledger multipart blocks and index use repeatable byte-array payloads
for V4 signing; the native object layout is unchanged. Blocks are bounded by the
configured 5 MiB offload block size. This is a maintained source patch, not a
stock-image R2 compatibility claim; the separate streaming-offload path is not
changed. See [the original offloader](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java).

Build before starting the broker:

```bash
pnpm compose -- -f docker-compose.yml -f docker-compose.pulsar.yml --profile pulsar build pulsar-broker
```

Use an isolated builder with an explicit memory/CPU budget and enough aggregate
Docker VM headroom; do not overlap compilation with a constrained qualification
runtime. The Dockerfile runs the offloader test class and Java style checks with
retries disabled before packaging its NAR. In this workstation's saturated shared
VM, the complete source build ran successfully on the macOS host instead; image
packaging passed using that tested artifact through Docker's supported named
build-context stage override. A cold full Docker source build remains unverified
locally. Docker documents [build contexts](https://docs.docker.com/build/concepts/context/)
and [builder resource options](https://docs.docker.com/build/builders/drivers/docker-container/).

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

The separate [CDC qualification](../../docs/pulsar-cdc-assessment.md#confirmed-timestamp-trigger-and-qualified-target-version)
records a server-side timestamp regression: a direct HTTP `VALUES` batch with a
DateTime64 value followed by NULL failed on 26.9.19.9 and passed on the isolated
26.10.2.103 candidate. [timestamp-values.sql](timestamp-values.sql) is the minimal
fixture; its target must be created in the isolated `qualification` database as
`timestamp_values_probe(id Int32, ended_at Nullable(DateTime64(6, 'UTC')))` with a
MergeTree engine ordered by `id`. POST the SQL directly through the test HTTP
client and verify both rows and six-digit precision. This fixture is not a
production migration or approval to upgrade the production engine. The candidate
version is documented in the [official release](https://github.com/ClickHouse/ClickHouse/releases/tag/v26.10.2.103-stable).

The [absolute-spill qualification](../../docs/pulsar-cdc-assessment.md#approved-absolute-spill-qualification)
also verifies native query behavior, including a negative physical-disk result:
the query's temporary-data allowance did not strictly bound its sort directory
on either tested local engine. Do not treat that setting as filesystem
isolation or as approval to lower service ceilings. Native spilling reduced
memory, but the full production-data read still exceeded its temporary-data
budget; production cutover remains blocked.
