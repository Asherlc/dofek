# Local prerequisites during hardware-metadata validation — 2026-10-24

This was a local development validation issue. Production was not changed and
there was no observed production user impact.

## Docker address pools

`pnpm compose -- up -d --wait db clickhouse redis redpanda` first failed while
creating the workspace network, with `all predefined address pools have been
fully subnetted`. Inspection found 55 bridge networks, including many empty
workspace networks. `fresh-hyena_default` had zero attached containers and no
registered worktree; its full inspect response was saved before removal. Only
that network was removed. No containers or database volumes were removed.

The original Compose command then succeeded and Postgres, ClickHouse, Redis and
Redpanda all became healthy. Docker documents the relevant [network inspection](https://docs.docker.com/reference/cli/docker/network/inspect/)
and [network removal](https://docs.docker.com/reference/cli/docker/network/rm/)
operations. No runtime retries, sleeps, timeouts or network-configuration changes
were introduced. Other unused workspace networks remain; future cleanup should
inspect ownership and attachments before removing any individual network.

## ClickHouse test bootstrap

The initial command was:

```sh
pnpm test:integration packages/server/src/repositories/activity-hardware-repository.integration.test.ts packages/server/src/repositories/activity-metric-sources-repository.integration.test.ts
```

The first fatal line reported `(total) memory limit exceeded`, current RSS and
maximum both `1.25 GiB`, with the query selected to stop. The existing generic
test helper was rebuilding unrelated activity-origin analytics before source
tests began. One focused repeat reproduced the prerequisite failure.

The [new label integration fixture](../../packages/server/src/repositories/activity-hardware-labels.integration.test.ts)
creates only the current raw-stream and scalar-sample tables required to execute
the actual label SQL. The focused hardware reader/label command passed three
real Postgres/ClickHouse tests. No production model, server-memory limit, retry,
or timeout setting changed. The broad existing bootstrap remains subject to its
local memory requirement; this change does not claim to repair that helper.

## Follow-up

Reusing focused executable database fixtures made the ownership, partial-message
and source-label checks practical. Add a minimal raw-stream/scalar-sample fixture
recipe to the testing guide, and keep workspace network cleanup distinct from
database-volume deletion. The [testing guide](../testing.md#integration-dependencies)
covers the isolated dependency setup for future runs.
