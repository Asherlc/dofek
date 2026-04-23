# Database

This directory contains the Drizzle ORM schema, migrations, and database connection logic.

## Architecture

- **PostgreSQL + TimescaleDB**: The database is PostgreSQL with TimescaleDB extensions for efficient time-series data storage.
- **Drizzle ORM**: Used for type-safe database access and migrations.
- **Fitness Schema**: All tables live in the `fitness` schema.

## Key Tables

- `user_profile`: User profiles and settings.
- `provider`: Registered data providers linked to users.
- `oauth_token`: OAuth credentials for provider APIs.
- `activity`: Cardio/endurance workout sessions.
- `metric_stream`: Unified time-series table for sensor data (Heart Rate, Power, IMU, etc.) stored as a TimescaleDB hypertable.
- `daily_metrics`: Aggregated daily health data (HRV, Resting HR, steps).
- `sleep_session`: Detailed sleep duration and stages.
- `dexa_scan`: Body composition data from DEXA scans (BodySpec).
- `journal_entry`: Daily self-report data.

## Implementation Notes

- **Metric Channels**: The `metric_stream` table uses a `channel` column to differentiate between data types (e.g., `heart_rate`, `power`).
- **Deduplication**: `dedup.ts` contains logic to pick the highest-priority provider when multiple sources report the same metric for an activity.
- **Nutrient Columns**: Shared nutrient columns are generated via `nutrient-columns.ts`.
- **Views**: Materialized views and database-level views are managed in `sync-views.ts`.
  View syncing is triggered out-of-band (not in the blocking schema migration path).
