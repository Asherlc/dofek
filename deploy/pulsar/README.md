# Isolated Pulsar qualification

This directory builds and configures a disposable Pulsar 5.0.1, BookKeeper and
Oxia topology. It does not change the production stack or its transport.
See [qualification and remaining gates](../../docs/pulsar-foundation-qualification.md).

The broker Dockerfile builds checksum-pinned Apache source with a narrow
[repeatable payload patch](repeatable-offload-payload.patch). Its bounded sealed
ledger blocks and index can be reopened for signing and upload; native object
layout is unchanged. The build runs the affected upstream test class and style
checks with retries disabled. The standalone
[source-build workflow](../../.github/workflows/pulsar-source-build.yml) checks
that normal Docker source path on ARM with a verified 4 GiB builder limit,
without importing a host-built NAR. Its [workflow runs](https://github.com/Asherlc/dofek/actions/workflows/pulsar-source-build.yml)
provide commit-specific build evidence; the workflow definition alone is not a
passing qualification result. The [ARM job at 7f98465d7](https://github.com/Asherlc/dofek/actions/runs/41993332932/job/127130525556)
passed the cold build, both style checks, NAR packaging and selected upstream
tests. Docker documents the builder's
[memory and swap controls](https://docs.docker.com/build/builders/drivers/docker-container/).
See the [pinned upstream offloader](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java).

Build through the workspace wrapper:

```bash
pnpm compose -- -f docker-compose.yml -f docker-compose.pulsar.yml --profile pulsar build pulsar-broker
```

Before runtime, use a fresh isolated project with enough aggregate memory and disk.
Oxia has separate persistent data-server and coordinator state, with separate
Pulsar and BookKeeper namespaces. Follow the [versioned Oxia admin commands](https://github.com/oxia-db/oxia/tree/v0.18.0/cmd/admin)
to register the data server and namespaces. Format only fresh qualification
BookKeeper metadata, without force, before the first bookie start. Never format
populated metadata or delete existing volumes. These are explicit qualification
actions; production bootstrap is not implemented here.

### Metadata readiness before initialization

Do not start the entire profile on an empty metadata store. First start only
`pulsar-oxia` and `pulsar-oxia-coordinator`, using the wrapper and file chain
above with a fresh `--project-suffix`. Keep that suffix for every command.
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
