# ClickHouse catalog payload accounting qualification

Q17 (`Y`) authorized this offline fix and review-image preparation. Production
remains on Redpanda after the [pre-write recovery](../kafka-cutover-attempt-20261108/README.md).
No deployment, data deletion, migration or budget increase follows from this receipt.

## Change

The old catalog preflight charged 256 bytes of fixed overhead per column. It
rejected production's 214-table/3,043-column catalog at an estimate of 1,221,082
bytes, before ownership inspection. The correction counts JSON-encoded variable
strings and column pairs, plus a conservative 256-byte fixed envelope **per table**.
The envelope covers fixed JSON keys, delimiters, line termination and a 64-bit age;
the database/name/engine/UUID strings are counted separately.

The preflight remains before `groupArray` materialization. Its 500-table and
1 MiB inclusive limits, complete catalog query, schema validation and ownership
classification are unchanged. No tables or columns are excluded to fit the cap.
The implementation uses stock [`toJSONString`](https://clickhouse.com/docs/reference/functions/regular-functions/json-functions#tojsonstring)
to account for escaping, with no new dependency, exported helper or validator.

## Tests and measurements

The first real-engine test failed on the old implementation with the exact
production metadata-budget error. After the correction:

| Check | 26.6.1.1193 | 26.10.2.103 |
|---|---|---|
| Large catalog: all 40 tables/3,240 columns retained; unowned UUID identity still rejected | Pass | Pass |
| Escaped type metadata retained | Pass | Pass |
| Catalog with over 1 MiB of encoded column metadata rejected | Pass | Pass |

The oversized fixture uses eight tables below the engine's individual metadata
limit, rather than increasing a query-size setting. Both runs used `--retry=0`.
The 161 existing coverage unit tests include inclusive 500-table/1 MiB boundaries
and over-limit failures. Root TypeScript and changed-file Biome checks passed.

A temporary diagnostic recorded the raw JSONEachRow response from the public
coverage function, then passed the unmodified decoded rows to that function.
It used only empty local fixtures and was not added as a maintained tool.

| Fixture | Engine | Estimate | Actual decoded HTTP body |
|---|---|---:|---:|
| 40 tables / 3,240 columns | 26.6 | 88,830 B | 81,390 B |
| 40 tables / 3,240 columns | 26.10 | 88,830 B | 81,430 B |
| Escaped types, 2 tables / 130 columns | 26.6 | 98,168 B | 97,796 B |
| Escaped types, 2 tables / 130 columns | 26.10 | 98,168 B | 97,794 B |

[Machine-readable measurements](payload-measurements.json) contain no production
schema contents, credentials, user identifiers or event bodies. These are payload
bounds, not a heap-memory or query-latency benchmark.

The production-version lab used pinned image
`clickhouse/clickhouse-server:26.6.1.1193-alpine@sha256:1904267fde1d8b794c9e5fda1b5a4bffd9b2e5b3d1057d5911161257125956f3`
in the isolated `catalog266` Compose project. That project's containers and
network were removed; temporary databases were dropped by fixture cleanup.
Shared services and database volumes were preserved.

## Release gate

The new image must pass the existing read-only coverage inspection against the
live catalog before another maintenance proposal. This receipt does not claim
that production ownership coverage passed, that full CI completed, or that a
new image has been deployed. Historical metric-ID audits remain complete and
do not need to be repeated.
