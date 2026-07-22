# Database

This directory contains the Drizzle ORM schema, migrations, and database connection logic.

## Architecture

- **PostgreSQL + TimescaleDB + PostGIS**: The database is PostgreSQL with TimescaleDB for time-series storage and PostGIS for geospatial metric data.
- **Drizzle ORM**: Used for type-safe database access and migrations.
- **Fitness Schema**: All tables live in the `fitness` schema.

## Key Tables

- `user_profile`: User profiles and settings.
- `provider`: Registered data providers linked to users.
- `oauth_token`: OAuth credentials for provider APIs.
- `activity`: Cardio/endurance workout sessions.
- `daily_metrics`: Aggregated daily health data (HRV, Resting HR, steps).
- `sleep_session`: Detailed sleep duration and stages.
- `dexa_scan`: Body composition data from DEXA scans (BodySpec).
- `journal_entry`: Daily self-report data.

## Implementation Notes

- **Metric Stream**: High-volume sensor samples are not stored in Postgres. They publish to Redpanda, archive to R2, and serve analytics from ClickHouse.
- **Deduplication**: Activity sensor analytics read from deduplicated ClickHouse read models.
- **ClickHouse Analytics Models**: Expensive derived ClickHouse tables are maintained by dbt models in `analytics/models/`. `analytics.sensor_scalar_sample`, `analytics.deduped_sensor`, `analytics.resting_heart_rate_sleep_window`, and `analytics.activity_vo2max_estimate` are incremental dbt models populated outside the web/API request path.
- **Nutrient Columns**: Shared nutrient columns are generated via `nutrient-columns.ts`.
- **Integration Test Databases**: `pnpm test:integration` starts the workspace Compose stack and provides `TEST_DATABASE_URL`. The test helper creates one migrated PostgreSQL template per Vitest process and clones isolated databases from it; PostgreSQL documents this behavior in [`CREATE DATABASE ... TEMPLATE`](https://www.postgresql.org/docs/current/sql-createdatabase.html).

## Migrations

- Postgres migrations live in `drizzle/`, must be registered in
  `drizzle/meta/_journal.json`, and are applied by Drizzle's node-postgres migrator inside the
  repository's advisory-lock wrapper. See [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
  and [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
- Postgres migration files must remain transaction-compatible. Do not use file-level
  transaction control or `CREATE INDEX CONCURRENTLY`; PostgreSQL documents that concurrent
  index creation cannot run inside a transaction block in [`CREATE INDEX`](https://www.postgresql.org/docs/current/sql-createindex.html).
- ClickHouse migrations live in `clickhouse-migrations/` as one TypeScript module per migration, ordered by `clickhouse-migrations/registry.ts`.
- Deploy migrations are for schema changes only. Historical backfills and full read-model rebuilds should run as explicit resumable scripts or jobs, not inside the deploy migration path.
- Run `pnpm analytics:build`, `pnpm lint:migrations`, `pnpm lint:analytics-sql`, and `pnpm lint:analytics-policy` before pushing migration or ClickHouse analytics changes.

## Climbing Attempt Count Backfill

After deploying migration `0055_climbing_attempt_count`, preview the Kaya backfill with
`pnpm backfill:climbing-attempt-count`. Run it again with `--execute` to copy valid positive
integer attempt counts from preserved Kaya raw payloads into the canonical `attempt_count`
column. The operation is idempotent and reports how many rows would change or changed; see
the [backfill implementation](../../scripts/backfill-climbing-attempt-count.ts).
