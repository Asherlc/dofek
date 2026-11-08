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

The [review-image build](https://github.com/Asherlc/dofek/actions/runs/42458515073)
passed for source `cb6c6810deb8abfe3cebb74f5d1603af3f399973`. Published image:
`ghcr.io/asherlc/dofek@sha256:54e475a010854f7cf78ff5d102a78c3347c93320dae8258ff44603cb21c2f9c2`.
Its ARM64 manifest is
`sha256:105e5c0102b875cb1c110a43f96a2effb386b6fb6c3ac4aa58dd39a2d9b12e77`;
registry revision and `SENTRY_RELEASE` match that source.

At 07:26 UTC the new image's public inspector passed the production size gate,
then failed closed on the unclassified physical table
`analytics.__dbt_exchange_test_0_43766ed9821e11f1837d02420a000126`.
Read-only system metadata at 07:27 UTC reported a MergeTree with one `test String`
column, zero rows, zero bytes, and metadata last modified on July 17. No data-table
scan, migration, table deletion or serving-service update was performed.

That name and schema match the adapter's atomic-exchange capability probe. The
[pinned dbt-clickhouse 1.10.3 source](https://github.com/ClickHouse/dbt-clickhouse/blob/v1.10.3/dbt/adapters/clickhouse/dbclient.py#L247-L282)
creates two such tables and attempts to drop them in `finally`. This supports
identifying a leftover probe; it does not establish the historical cleanup
failure's cause. No table-name exemption or weakened ownership rule was added.

Production ownership coverage remains **blocked**. A narrowly approved operator
cleanup of this exact empty probe, followed by the unchanged inspector, is the
proposed next step. Recheck its schema/emptiness and active use before any approved
drop; stop on changed state. A new cutover still requires separate approval.
[Exact-source CI](https://github.com/Asherlc/dofek/actions/runs/42458473396) was
running without observed failed jobs when this receipt was recorded. Historical
metric-ID audits remain complete and do not need to be repeated.

## Q18 cleanup and next blocker

Q18 (`Y`) approved only the exact empty probe cleanup and another unchanged
inspection. At **2026-11-08T14:07:00Z**, the operator rechecked its MergeTree
engine, sole `test String` column, zero metadata rows/bytes, zero active queries
referencing the table and an exact zero row count. Stock `DROP TABLE … SYNC`
removed only that table; a system-catalog lookup verified absence. No permanent
exception or application-source change was introduced.

The inspector then failed closed at
`analytics.activity_effort_identity.canonical_activity_id`, reporting that the
column is not mapped to an ownership relation. The
[model source](../../../analytics/models/read_models/activity_effort_identity.sql)
derives this field from `deduped_activity_members.activity_id` and retains
`user_id`. The existing typed relation declaration recognizes `canonical_id`
and `activity_id` but omits `canonical_activity_id`. This is a real relation
mapping gap; deleting or exempting the personal-data model is not a solution.

The proposed follow-up is an offline audit of current model identity aliases,
minimal additions to existing typed mappings, and real-engine erasure regression
tests before another image/inspection. Q18 explicitly stops at this further
blocker; no fix or new cutover has been performed. Production remains Redpanda
1/1, Kafka 0/0, web 2/2 and worker 1/1 at the post-cleanup service census.

[CI 42458970793](https://github.com/Asherlc/dofek/actions/runs/42458970793)
passed on documentation head `fea940d4aa40d96a32afc1e3b7909fa4f3196175`.
Its only differences from the built runtime are this qualification documentation
and the incident baseline. The prior exact-source CI was cancelled by that push;
do not describe it as a completed passing run.
