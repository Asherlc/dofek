# Database

This directory contains the Drizzle ORM schema, migrations, and database connection logic.

## Architecture

- **PostgreSQL + TimescaleDB + PostGIS**: The database is PostgreSQL with TimescaleDB for time-series storage and PostGIS for geospatial metric data.
- **Drizzle ORM**: Used for type-safe database access and migrations.
- **Fitness Schema**: All tables live in the `fitness` schema.

## Key Tables

- `user_profile`: User profiles and settings.
- `provider`: Global catalog of registered data provider types.
- `provider_connection`: Authoritative per-user provider connections.
- `provider_issue_email`: Accepted issue-email delivery for each connection. The
  [notification query](./provider-issue-notification.ts) alerts immediately for
  confirmed refresh-token revocation. Other authorization failures wait for the
  next automatic sync: recovery sends no email, another error sends one. Repeated
  manual failures alone do not trigger that confirmation. Generic errors require
  two automatic failures. Successful overall syncs clear the failure streak;
  history from before the current connection was created is excluded. The
  [integration tests](./provider-issue-notification.integration.test.ts) exercise
  recovery, confirmation, delivery retry, and concurrent suppression.
- `oauth_token`: OAuth credentials for provider APIs.
- `activity`: Cardio/endurance workout sessions.
- `daily_metrics`: Aggregated daily health data (HRV, Resting HR, steps).
- `sleep_session`: Detailed sleep duration and stages.
- `dexa_scan`: Body composition data from DEXA scans (BodySpec).

## Implementation Notes

- **Metric Stream**: High-volume sensor samples are not stored in Postgres. They publish to Redpanda, archive to R2, and serve analytics from ClickHouse.
- **Deduplication**: Activity sensor analytics read from deduplicated ClickHouse read models.
- **ClickHouse Analytics Models**: Expensive derived ClickHouse tables are maintained by dbt models in `analytics/models/`. `analytics.sensor_scalar_sample`, `analytics.deduped_sensor`, `analytics.resting_heart_rate_sleep_window`, and `analytics.activity_vo2max_estimate` are incremental dbt models populated outside the web/API request path.
- **PeerDB Mirror Contracts**: `peerdb/mirror-contracts.ts` is the canonical list of PostgreSQL-to-ClickHouse table mappings and column exclusions. `peerdb/mirror-schema-validator.ts` compares PostgreSQL `information_schema.columns` with ClickHouse `system.columns` and fails when a projected source column or PeerDB metadata column is absent from its destination. Generated PeerDB mapping blocks omit `exclude` when a table has no excluded columns; see [PeerDB's CDC mirror command](https://docs.peerdb.io/sql/commands/create-mirror).
- **Nutrient Columns**: Shared nutrient columns are generated via `nutrient-columns.ts`.
- **Integration Test Databases**: `pnpm test:integration` starts the workspace Compose stack and provides `TEST_DATABASE_URL`. The test helper creates one migrated PostgreSQL template per Vitest process and clones isolated databases from it; PostgreSQL documents this behavior in [`CREATE DATABASE ... TEMPLATE`](https://www.postgresql.org/docs/current/sql-createdatabase.html).

## Activity Source Priority

The [Zepp priority migration](../../drizzle/0149_zepp_activity_priority.sql)
assigns generic activity priority `1` to native `amazfit-zepp` records and Apple
Health records whose `source_name` is exactly `Zepp`. It preserves the native
provider's existing non-activity category priority fallbacks. The
[activity source model](../../analytics/models/read_models/activity_source_records.sql)
resolves matching source priorities before provider defaults.

Priority remains below sensor richness and activity-type specificity in the
[representative ordering](../../analytics/models/read_models/deduped_activities.sql),
so denser recordings remain the analytics representative. The resolved recording
origin supplies the title and `primary_canonical_type` for its display fallback.
Explicit field priorities select notes and titles of unresolved-origin groups.

## Migrations

- Postgres migrations live in `drizzle/`, must be registered in
  `drizzle/meta/_journal.json`, and are applied by Drizzle's node-postgres migrator inside the
  repository's advisory-lock wrapper. See [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
  and [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
- Postgres migration files must remain transaction-compatible. Drizzle's node-postgres
  migrator applies its migration statements in a transaction, so do not use file-level
  transaction control or concurrent `CREATE`, `DROP`, or `REINDEX` statements. See
  [Drizzle's node-postgres migrator source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/node-postgres/migrator.ts)
  and PostgreSQL's transaction restrictions in
  [`CREATE INDEX`](https://www.postgresql.org/docs/current/sql-createindex.html),
  [`DROP INDEX`](https://www.postgresql.org/docs/current/sql-dropindex.html), and
  [`REINDEX`](https://www.postgresql.org/docs/current/sql-reindex.html).
- ClickHouse migrations live in `clickhouse-migrations/` as one TypeScript module per migration, ordered by `clickhouse-migrations/registry.ts`.
- Deploy migrations are for schema changes only. Historical backfills and full read-model rebuilds should run as explicit resumable scripts or jobs, not inside the deploy migration path.
- Run `pnpm analytics:build`, `pnpm lint:migrations`, `pnpm lint:analytics-sql`, and `pnpm lint:analytics-policy` before pushing migration or ClickHouse analytics changes.
- For a new Postgres migration, also run `uv tool run sqlfluff lint drizzle/<migration>.sql`.
  The [SQLFluff CI job](../../.github/workflows/test.yml) lints added migration files;
  the root [`pnpm lint` command](../../package.json) runs analytics SQL lint instead.

## Climbing logs

The [canonical graph](schema/climbing.ts) stores Area, Climb, Pitch, their owned
grade collections, ClimbingLogEntry, and scoped ClimbingAttempt records. Areas
use parent references; source objects are shared by verified owner/provider
identity. Coordinates use native PostgreSQL
[points](https://www.postgresql.org/docs/current/datatype-geometric.html).

The [transactional writer](climbing-log-sync.ts) expands reported counts into
scoped occurrences and retains each supplied partially described attempt when a
total is missing. Sources can supply an empty attempts array when only the log
occurrence is known; this creates no attempt rows, as verified by the
[database regression](climbing-log-sync.integration.test.ts). Recorded booleans and raw source result labels remain independently
nullable. `fitness.v_climbing_attempt` computes outcome from each occurrence's
raw completion boolean when supplied, otherwise its original supported label.
The writer accepts at most 1,000 attempts per reported count. Larger source
counts fail validation before any graph writes rather than expanding an
unbounded number of rows. The error identifies the occurrence by source ID and
its name when available; the same database suite tests the accepted boundary
and atomic rejection.
The [completion migration](../../drizzle/0172_source_climbing_completion.sql)
preserves the existing served shape while extending the
[canonical result function](../../drizzle/0148_compute_climbing_attempt_outcome.sql).
Methods remain nullable for every climb kind. Missing source evidence does
not establish a method; omitted fields preserve existing facts and explicit
null clears them. The [nullable-method migration](../../drizzle/0171_nullable_climbing_route_methods.sql)
removes the earlier cross-table requirement using PostgreSQL
[`DROP TRIGGER`](https://www.postgresql.org/docs/current/sql-droptrigger.html);
it does not rewrite historical attempts.
The readonly `fitness.v_climbing_log_entry` projection derives current paths,
owned grade arrays, counts, and compatible free-send status; PostgreSQL
[views](https://www.postgresql.org/docs/current/sql-createview.html) provide this
projection without duplicate stored metrics.

Populated upgrades use `pnpm migrate:climbing-log-model` and the
[maintenance runbook](../../docs/climbing-log-model-cutover.md). Preparation,
bounded conversion, validation, and finalization require quiesced old readers
and writers. Fresh empty installations apply both schema stages directly.
The subsequent [computed-outcome migration](../../drizzle/0148_compute_climbing_attempt_outcome.sql)
also requires quiescing old readers and writers; it verifies raw evidence before
removing the stored outcome. The [model guide](../../docs/climbing-context.md#maintenance-cutover)
describes that boundary.

## Activity recording origin

The [origin function](../../drizzle/_views/00_activity_origin.sql) chooses the
closest available recording from provenance within a group. The
[activity view](../../drizzle/_views/01_v_activity.sql) exposes nullable primary
identity separately from representative_activity_id, which retains the former
field representative. Origin never falls back to field priority.

PostgreSQL migration 0152_activity_origin installs the function and updates the
view. ClickHouse migration 0104_activity_origin adds the serving columns and the
[origin projection](clickhouse-activity-origin.ts). Existing ClickHouse rows have
no proven primary provider until dbt recomputes origin; their former representative
is retained. See the [selector](../../analytics/macros/activity_origin.sql) for
supported evidence and the [rollout runbook](../../docs/clickhouse-read-model-deploy-runbook.md#recording-origin-rollout).

The [Peloton origin migration](../../drizzle/0169_peloton_activity_origin.sql)
extends initiating-origin policy to native Peloton bikes with normalized
`platform=home_bike` and `deviceType=bike` or `home_bike_plus`. Strava's normalized
`Peloton Bike` source/device label establishes a Peloton-to-Strava transfer;
an independent WHOOP recording retains its own Apple Health transfer evidence.
Incomplete or contradictory metadata and multiple initiating recordings remain
unresolved. The [shared real-engine fixtures](../test-fixtures/activity-origin.json)
define these cases for PostgreSQL and ClickHouse.
