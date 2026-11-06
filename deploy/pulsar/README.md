# Isolated Pulsar qualification

This directory holds Oxia coordinator config for a disposable Pulsar 5.0.1,
BookKeeper and Oxia topology. It does not change the production stack or its
transport. See [qualification and remaining gates](../../docs/pulsar-foundation-qualification.md).

Qualification Compose uses the pinned official image
`apachepulsar/pulsar:5.0.1@sha256:4507075d8c11b34629f3a0b41f48e3c659951e601538562ee0c088cd2c737ec0`
with its bundled `tiered-storage-jcloud` NAR. There is no custom Dockerfile,
source rebuild, or NAR mount. Local offload targets Compose MinIO via the stock
`aws-s3` driver and legacy `s3ManagedLedgerOffload*` settings (64 MiB block
baseline). Cloud object stores are out of band for this Compose profile.
Apache documents the [Docker image](https://pulsar.apache.org/docs/5.0.x/deploy-docker/)
and [tiered storage / offload](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/).
Production offload configuration is reviewed and Infisical-provisioned
separately from this qualification directory.

Historical custom-image / R2-patch publish path (superseded; immutable links
only):
[Dockerfile at 7f98465d7](https://github.com/Asherlc/dofek/blob/7f98465d7330c554d5f71364cab29aff325e0f0c/deploy/pulsar/Dockerfile),
[repeatable-offload-payload.patch at eab7e32df](https://github.com/Asherlc/dofek/blob/eab7e32dfa9509e1e1e893560a10dbe288a09f80/deploy/pulsar/repeatable-offload-payload.patch),
[pulsar-source-build.yml at eab7e32df](https://github.com/Asherlc/dofek/blob/eab7e32dfa9509e1e1e893560a10dbe288a09f80/.github/workflows/pulsar-source-build.yml).
See the [pinned upstream offloader](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java).

Before runtime, use a fresh isolated project with enough aggregate memory and disk.
Oxia has separate persistent data-server and coordinator state, with separate
Pulsar and BookKeeper namespaces. Follow the [versioned Oxia admin commands](https://github.com/oxia-db/oxia/tree/v0.18.0/cmd/admin)
to register the data server and namespaces. Format only fresh qualification
BookKeeper metadata, without force, before the first bookie start. Never format
populated metadata or delete existing volumes. These are explicit qualification
actions; production bootstrap is not implemented here.

### Metadata readiness before initialization

Do not start the entire profile on an empty metadata store. First start only
`pulsar-oxia` and `pulsar-oxia-coordinator`, using the workspace Compose wrapper
and `docker-compose.yml` + `docker-compose.pulsar.yml` with a fresh
`--project-suffix`. Keep that suffix for every command.
Starting a container is not proof that its metadata service is ready.

Run the following native admin operations through
`exec -T pulsar-oxia-coordinator oxia admin --admin-address localhost:6650 --output json`:

1. `dataserver get`: require a successful JSON response before proceeding.
2. `dataserver create pulsar-oxia --public pulsar-oxia:6648 --internal pulsar-oxia:6649`.
3. `namespace create pulsar --initial-shards 1 --replication-factor 1`.
4. `namespace create bookkeeper --initial-shards 1 --replication-factor 1`.
5. `namespace get pulsar` and `namespace get bookkeeper`: require both namespaces
   and their shard assignments to name the expected server before initialization.

Stop on a failed prerequisite; do not start `pulsar-init`, format metadata or
add a retry to conceal it. The [native fixture](../../src/metric-stream/bookie-evacuation.pulsar.integration.test.ts)
demonstrates the coordinator-read and BookKeeper assignment checks against
the pinned [Oxia admin implementation](https://github.com/oxia-db/oxia/tree/v0.18.0/cmd/admin).
Only after those observations may the operator initialize Pulsar metadata and
format fresh BookKeeper metadata, then start the bookie and broker.

The Pulsar initializer itself tolerates existing cluster, tenant and namespace
metadata through its [create-if-absent operations](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-broker/src/main/java/org/apache/pulsar/PulsarClusterMetadataSetup.java).
Do not add a skip-on-error branch. These fresh-project instructions do not
authorize formatting existing BookKeeper storage on a subsequent start.

No ports are published. Use the packaged tools through the Compose wrapper.
Replication factor one and restart tests do not prove recovery from disk loss.
See [Apache deployment](https://pulsar.apache.org/docs/5.0.x/deploy-docker/) and
[BookKeeper CLI](https://bookkeeper.apache.org/docs/reference/cli/).
