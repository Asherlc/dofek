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

## Migrations

- Postgres migrations live in `drizzle/` and are applied by `runMigrations()`.
- ClickHouse migrations live in `clickhouse-migrations/` as one TypeScript module per migration, ordered by `clickhouse-migrations/registry.ts`.
- Deploy migrations are for schema changes only. Historical backfills and full read-model rebuilds should run as explicit resumable scripts or jobs, not inside the deploy migration path.
- Run `pnpm analytics:build`, `pnpm lint:migrations`, `pnpm lint:analytics-sql`, and `pnpm lint:analytics-policy` before pushing migration or ClickHouse analytics changes.
