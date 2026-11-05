# Isolated Pulsar qualification

This directory builds and configures a disposable Pulsar 5.0.1, BookKeeper and
Oxia topology. It does not change the production stack or its transport.
See [qualification and remaining gates](../../docs/pulsar-foundation-qualification.md).

The broker Dockerfile builds checksum-pinned Apache source with a narrow
[repeatable payload patch](repeatable-offload-payload.patch). Its bounded sealed
ledger blocks and index can be reopened for signing and upload; native object
layout is unchanged. The build runs the affected upstream test class and style
checks with retries disabled. A cold Docker source build still requires verification.
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

No ports are published. Use the packaged tools through the Compose wrapper.
Replication factor one and restart tests do not prove recovery from disk loss.
See [Apache deployment](https://pulsar.apache.org/docs/5.0.x/deploy-docker/) and
[BookKeeper CLI](https://bookkeeper.apache.org/docs/reference/cli/).
