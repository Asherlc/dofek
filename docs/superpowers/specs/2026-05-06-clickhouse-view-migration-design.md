# ClickHouse View Migration Design

## Goal

Move the remaining derived fitness views out of Postgres and into ClickHouse so deploys no longer run view DDL or refresh materialized views against hot production Postgres relations. Postgres remains the transactional source of truth for raw and user-managed data. ClickHouse becomes the analytics read-model layer and keeps projections current from mirrored raw tables.

## Problem

Deploy run `25443588374` showed the current failure mode clearly. The migrator finished normal Postgres migrations, then entered view sync and logged `fitness.v_daily_metrics is a plain view, applying unconditionally`. The corresponding Postgres query was `CREATE OR REPLACE VIEW fitness.v_daily_metrics AS ...`, which waited on relation locks behind long-running app reads. Once the DDL lock request queued, later app reads also queued behind it.

This is not isolated to `v_daily_metrics`. The remaining `drizzle/_views` definitions are all deploy-managed derived projections:

- `fitness.v_activity`
- `fitness.v_sleep`
- `fitness.v_body_measurement`
- `fitness.v_daily_metrics`
- `fitness.provider_stats`
- `fitness.derived_resting_heart_rate`

The app also has ingestion hooks and admin paths that refresh some of these views. Those hooks keep Postgres responsible for derived analytics maintenance and reintroduce lock pressure under normal traffic.

## Scope

This migration removes the remaining Postgres-derived view layer from runtime and deploy workflows.

In scope:

- Create ClickHouse analytics read models for every remaining derived view.
- Mirror the raw Postgres tables needed by those read models through PeerDB or existing ClickHouse PostgreSQL database access.
- Switch server read paths from `fitness.v_*`, `fitness.provider_stats`, and Postgres `derived_resting_heart_rate` to ClickHouse-backed repositories.
- Remove deploy-time Postgres view synchronization.
- Remove ingestion-time Postgres materialized-view refresh triggers.
- Remove admin/manual Postgres view refresh behavior.
- Keep tests proving deploy and ingestion no longer issue Postgres view DDL or refreshes.

Out of scope:

- Changing raw ingestion semantics.
- Storing derived analytics back into Postgres app tables.
- Adding dual-write derived tables from application code.
- Changing user-visible metric definitions except where an existing Postgres view definition is translated exactly into ClickHouse SQL.

## Architecture

Postgres keeps raw data and transactional state:

- activities and activity membership inputs
- sleep sessions and sleep stages
- daily metric rows
- body measurements
- user profiles
- providers and provider/device priorities
- sync logs and provider connection state

ClickHouse stores analytics read models:

- `analytics.v_activity`
- `analytics.v_activity_members`
- `analytics.v_sleep`
- `analytics.v_body_measurement`
- `analytics.v_daily_metrics`
- `analytics.provider_stats`
- `analytics.derived_resting_heart_rate`
- existing `analytics.deduped_sensor`
- existing `analytics.activity_summary`

Raw dependencies are mirrored into ClickHouse under `postgres_fitness.*` with PeerDB-managed metadata columns. Read models are created with tracked ClickHouse migrations and maintained by ClickHouse refreshable materialized views. Web deploys run ClickHouse migrations, but they do not run Postgres `CREATE OR REPLACE VIEW`, `DROP VIEW`, `DROP MATERIALIZED VIEW`, or `REFRESH MATERIALIZED VIEW` for these projections.

## Data Flow

1. Ingestion writes raw records to Postgres only.
2. PeerDB mirrors required raw tables into ClickHouse.
3. ClickHouse read models refresh from the mirrored raw tables and existing analytics models.
4. Server repositories query ClickHouse for analytics projections.
5. Postgres queries continue only for transactional reads and writes.

The server must fail loudly when a migrated analytics path is called without a configured ClickHouse store. The failure message should name the feature and `CLICKHOUSE_URL`, matching the existing activity analytics pattern.

## Read Model Mapping

`analytics.v_activity` replaces `fitness.v_activity`.

It preserves activity deduplication, canonical activity selection, source provider tracking, activity member expansion, and all fields currently consumed by server repositories. `analytics.v_activity_members` replaces the existing Postgres proxy/member view used by ClickHouse activity analytics.

`analytics.v_sleep` replaces `fitness.v_sleep`.

It preserves provider/device priority selection, overlap-based deduplication, sleep-stage derived fields, nap filtering fields, and efficiency calculation. Sleep stage joins should stay in ClickHouse so server sleep endpoints do not need to recompute stage totals.

`analytics.v_body_measurement` replaces `fitness.v_body_measurement`.

It preserves time-window clustering, provider/device priority selection by metric field, and `source_providers`.

`analytics.v_daily_metrics` replaces `fitness.v_daily_metrics`.

It preserves the split priority model: recovery priority for recovery metrics and daily activity priority for activity metrics. It keeps per-field source selection and source provider aggregation.

`analytics.derived_resting_heart_rate` replaces `fitness.derived_resting_heart_rate`.

It computes the nightly resting heart rate from sleep windows and heart-rate metric samples in ClickHouse. It keeps the current minimum sample requirement and lower-decile average behavior.

`analytics.provider_stats` replaces `fitness.provider_stats`.

It counts raw records by provider from mirrored raw tables. It should not depend on any migrated derived view unless that dependency is intentional and tested.

## Server Boundaries

The server should not scatter raw ClickHouse SQL across routers. Add or extend repository/store classes around each migrated read model:

- daily metrics repository
- sleep repository
- activity repository paths currently backed by `fitness.v_activity`
- body repository
- provider stats/sync repository
- derived cardio/resting-heart-rate repository
- shared analytics fragments used by healthspan, recovery, predictions, correlations, insights, and life events

Where a router already depends on `ClickHouseActivitySensorStore`, extend that dependency pattern instead of adding a parallel client style.

## Removal Plan

After all consumers are switched:

- Delete `src/db/sync-views.ts` and its tests.
- Remove `drizzle/_views/*.sql`.
- Remove deploy workflow steps and migration code that call Postgres view sync.
- Remove ingestion refresh calls for `fitness.v_activity` and `fitness.v_sleep`.
- Remove admin endpoints/actions that refresh Postgres materialized views.
- Remove Postgres proxy view migrations that exist only to expose derived views to ClickHouse.

No stopped or compatibility dual-route behavior should remain once the branch is complete.

## Testing

Use TDD for each slice.

Required test coverage:

- ClickHouse migration tests prove the analytics read models are created.
- Repository unit tests prove migrated repositories query `analytics.*` in ClickHouse and no longer query `fitness.v_*`.
- Integration tests compare representative output for daily metrics, sleep, activity, body measurements, provider stats, and resting heart rate.
- Ingestion tests prove HealthKit sync no longer refreshes Postgres views.
- Deploy/migration tests prove `run-migrate` no longer calls Postgres view sync and no longer emits `CREATE OR REPLACE VIEW` for derived projections.
- Existing activity analytics tests keep passing against ClickHouse-backed models.

Production validation requires a branch deploy from `aloud-bike` after checks pass. Success means the deploy reaches and passes ClickHouse CDC setup and stack deployment without running Postgres view DDL for the migrated projections.

## Rollout

This is a full migration branch. The implementation can still be committed in slices:

1. Add ClickHouse raw mirrors and read models.
2. Switch server consumers by domain.
3. Remove Postgres view sync and refresh hooks.
4. Run full local checks.
5. Push and validate with a branch deploy.

Each commit must leave the branch internally consistent enough for tests to explain what is complete. The final branch should not rely on fallback reads from the old Postgres views.

## Risks

ClickHouse SQL feature differences may require query rewrites for recursive or lateral Postgres logic. Those rewrites must preserve behavior through representative integration tests rather than by assertion.

PeerDB coverage may be incomplete for some raw dependency tables. Missing mirrors are deploy blockers and must fail loudly with explicit table or configuration names.

Some existing tests refresh Postgres materialized views to observe new data. Those tests must move to ClickHouse test helpers that sync or refresh the relevant analytics read models.

This migration increases ClickHouse responsibility. ClickHouse migrations and read-model refreshes need clear operational logs so future failures identify the exact read model instead of surfacing as generic deploy slowness.
