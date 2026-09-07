# Database Schema

Canonical source-of-truth tables live in the `fitness` Postgres schema. The source of
truth is the domain modules under `src/db/schema/` (Drizzle generates migrations from
them through `src/db/drizzle-schema.ts`). Rebuildable read models live outside
`fitness`, currently in the `analytics` schema.

## Data Model Philosophy: Raw Data Only

We only store raw, non-derivable data. If a value can be computed from other stored data, it should not have its own column. This keeps the schema honest and avoids stale or inconsistent derived values.

### What counts as "raw"

A column is raw if the data originates from a sensor or external system and **cannot** be recomputed from other columns we store.

### Columns we intentionally do NOT store

| Removed column | Why it's derivable |
|---|---|
| `metric_stream.distance` | Retired with the Postgres metric-stream table. **Outdoor** distance is computable from GPS lat/lng via haversine. **Indoor** distance is synthetic from virtual speed models, not a direct measurement. |
| `metric_stream.calories` | Retired with the Postgres metric-stream table. Device calories are computed from HR, power, body weight, and proprietary algorithms, not direct sensor readings. |
| `activity_interval.avg_heart_rate` | Computable from sensor_sample where channel='heart_rate' within the interval's time range. |
| `activity_interval.max_heart_rate` | Same — `MAX(scalar)` over the interval window. |
| `activity_interval.avg_power` | Same — `AVG(scalar)` where channel='power' over the interval window. |
| `activity_interval.max_power` | Same — `MAX(scalar)` where channel='power' over the interval window. |
| `activity_interval.avg_speed` | Same — `AVG(scalar)` where channel='speed' over the interval window. |
| `activity_interval.max_speed` | Same — `MAX(scalar)` where channel='speed' over the interval window. |
| `activity_interval.avg_cadence` | Same — `AVG(scalar)` where channel='cadence' over the interval window. |
| `activity_interval.distance_meters` | Same — computed from GPS within the interval. |
| `activity_interval.elevation_gain` | Same — computed from altitude deltas within the interval. |
| `daily_metrics.mindful_minutes` | Never populated by any provider. Dead column removed in migration 0042. |
| `daily_metrics.environmental_audio_exposure` | Apple Health stores raw audio exposure readings in sensor_sample (channel='audio_exposure') — daily averages can be derived from there. No provider ever populated this column. Removed in migration 0042. |
| `daily_metrics.headphone_audio_exposure` | Same as environmental — raw readings in sensor_sample, never aggregated to daily. Removed in migration 0042. |
| `daily_metrics.resting_hr` | Derived from low-percentile sleep-window heart-rate samples. Removed in migration 0007. |
| `daily_metrics.vo2max` | Derived from qualifying activity-level estimates using transparent public equations. Removed in migration 0007. |
| `daily_metrics.cycling_distance_km` | Derivable from activity distance/routes/sensor streams instead of stored as a duplicate daily total. Removed in migration 0046. |
| `daily_metrics.active_energy_kcal` | Provider/device estimate rather than an observation. Application ingestion and reads are retired; the nullable physical column remains temporarily for deployment compatibility. |
| `daily_metrics.basal_energy_kcal` | Formula-based provider/device estimate rather than an observation. Application ingestion and reads are retired; the nullable physical column remains temporarily for deployment compatibility. |
| `dexa_scan.resting_metabolic_rate_kcal` | Formula-based provider estimate rather than an observation. Application ingestion and reads are retired; the nullable physical column remains temporarily for deployment compatibility. |
| `dexa_scan.resting_metabolic_rate_raw` | Dedicated storage for formula estimates rather than opaque provider provenance. Application ingestion and reads are retired; the nullable physical column remains temporarily for deployment compatibility. |

The ClickHouse `analytics.activity_summary` read model computes these values from mirrored raw sensor data, including total distance (haversine over GPS points) and elevation gain/loss (altitude deltas).

### Columns we DO store and why they're not derivable

#### `daily_metrics`

| Column | Why it's raw |
|---|---|
| `hrv` | RMSSD/SDNN computed from R-R intervals during sleep. We don't store beat-to-beat R-R data. |
| `spo2_avg` | Pulse oximeter reading. Raw infrared/red light sensor data is not stored. |
| `respiratory_rate_avg` | Derived from accelerometer + PPG during sleep. Raw sensor streams unavailable. |
| `steps` | Accelerometer-counted throughout the day. We don't store raw accelerometer data. |
| `distance_km` | All-day walking/running distance from step count + stride length. Includes non-activity movement we don't track. |
| `flights_climbed` | Barometric altimeter counts. Raw pressure data not stored. |
| `exercise_minutes` | Device-determined from sustained HR elevation. Proprietary threshold logic. |
| `walking_speed`, `walking_step_length`, etc. | Apple Health walking analysis from phone accelerometer + gyroscope during daily walking. Raw IMU data not stored. |
| `skin_temp_c` | Skin temperature sensor (WHOOP, Oura ring). Raw thermistor data unavailable. |
| `stress_high_minutes`, `recovery_high_minutes` | Oura's proprietary stress/recovery classification from HRV + motion. |
| `resilience_level` | Oura's resilience score, proprietary algorithm. |

### Derived cardio metrics

Resting heart rate and VO2 Max are derived server-side. Resting heart rate comes from low-percentile sleep-window heart-rate samples. VO2 Max is averaged from qualifying activity-level estimates based on transparent public equations. Provider VO2 Max values are ignored for canonical scoring.

#### `sensor_sample` — unified time-series table

The `sensor_sample` table uses a "medium layout" — one row per (timestamp, channel) with a `scalar` column for single values and a `vector` (real[]) column for multi-axis data.

| Channel type | Example channels | Column used |
|---|---|---|
| Scalar | `heart_rate`, `power`, `cadence`, `speed`, `lat`, `lng`, `altitude`, `spo2`, etc. | `scalar` (real) |
| Vector | `imu` [x,y,z,gx,gy,gz], `accel` [x,y,z], `orientation` [w,x,y,z] | `vector` (real[]) |

**Why this layout?** Different sensors sample at different rates (GPS at 1Hz, IMU at 50Hz, HR from BLE at variable rates). The medium layout handles any sample rate without schema changes. New sensor types just add a new channel name — no migrations needed.

**Dedup strategy:** `analytics.deduped_sensor` is activity-agnostic. For each
`(user_id, channel, recorded_at)` key, the best scalar sample wins according to
the mirrored `fitness.sensor_provider_priority` and
`fitness.sensor_device_priority` tables, with deterministic tie-breakers.
Activity readers apply activity time windows when they query the table.

**Source type:** The `source_type` column ('ble', 'file', 'api') is informational — for debugging and auditing. It is NOT used for dedup priority.

See `src/db/sensor-channels.ts` for the full list of channel constants.

## Tables

### Reference

| Table | Purpose |
|-------|---------|
| `fitness.provider` | Global data-source catalog (wahoo, strava, etc.); `user_id` is a deprecated rollback-only field and is not authoritative. |
| `fitness.provider_connection` | Per-user provider connections, keyed by `(user_id, provider_id)`; this is the authoritative configured/connected relationship. |
| `fitness.exercise` | Canonical exercise library (provider-agnostic) |
| `fitness.exercise_alias` | Maps provider-specific exercise names to canonical exercises |

OAuth tokens and user-scoped webhook subscriptions reference the same
`(user_id, provider_id)` connection, so deleting one user's connection cascades
only that user's credentials. The deploy migration creates the catalog and
connection structures additively; after the new application version converges,
the resumable `backfill:provider-connections` command derives connections from
the legacy owner, OAuth tokens, and every raw child table, validates the
composite foreign keys, and removes the obsolete application-wide webhook
uniqueness index. PostgreSQL documents this `NOT VALID` then `VALIDATE
CONSTRAINT` cutover pattern for adding foreign keys without holding the
validation scan's stronger lock during the initial constraint addition:
<https://www.postgresql.org/docs/current/sql-altertable.html>.

### Activities

| Table | Purpose |
|-------|---------|
| `fitness.activity` | Any timed activity (type, times, raw JSONB summary from provider) |
| `fitness.activity_interval` | Laps/intervals with time ranges (metrics computed at query time from sensor_sample) |
| `fitness.sensor_sample` | Time-series sensor data (TimescaleDB hypertable) — all channels at any frequency |
| `fitness.finger_loading_entry` | Finger-loading protocols with raw edge, grip, load, bodyweight, laterality, set, hold, rest, RPE, and note values; existing rows remain read-only in the application |
| `fitness.climbing_entry` | Imported/provider climbs and retained historical Dofek-created climb definitions, including grade, wall angle, hold type, route, and location |
| `fitness.climbing_attempt` | Ordered raw outcomes, failure reasons, and notes for attempts on a retained climbing entry |

Retained Dofek-created climbing entries leave the legacy aggregate `sent` and `attempt_count`
columns null. Serving queries derive those values from `climbing_attempt`; imported
provider rows retain their provider-supplied aggregates. Finger-loading effective
load is likewise derived as bodyweight plus signed external load and is never
stored separately. Database constraints keep each outcome/failure-reason pair
consistent using PostgreSQL check constraints
([PostgreSQL `CREATE TABLE`](https://www.postgresql.org/docs/current/sql-createtable.html)).

### Subjective Inputs

| Table | Purpose |
|-------|---------|
| `fitness.body_region` | Seeded hierarchical reference regions, including bilateral fingers and A1–A5 pulley locations |
| `fitness.subjective_check_in` | One user-owned daily check-in; row presence distinguishes logged all-clear from missing data |
| `fitness.subjective_symptom` | Sparse soreness, stiffness, or tenderness scores for reported regions |
| `fitness.injury_event` | User-owned injury and niggle events with onset, optional resolution, severity, and description |

These tables store raw user-entered observations only. The server may assemble
date-window timelines for reading, but it does not store derived session load,
symptom correlations, or readiness scores. PostgreSQL foreign keys and check
constraints enforce ownership references and score/date boundaries
([PostgreSQL `CREATE TABLE`](https://www.postgresql.org/docs/current/sql-createtable.html)).

### Daily Metrics

| Table | Purpose |
|-------|---------|
| `fitness.daily_metrics` | Device-reported daily health data — HRV, steps, SpO2, walking biomechanics |

### Continuous Aggregates

Use Timescale continuous aggregates for straightforward time-bucket rollups where the query is grouped by time and stable dimensions. Keep deduplication-heavy analytics in ClickHouse read models so deploys do not rebuild hot Postgres projections.

| View | Purpose |
|------|---------|
| `fitness.cagg_sensor_daily` | Daily stats per (user, channel) from sensor_sample |
| `fitness.cagg_sensor_weekly` | Weekly rollup from daily cagg |

### Derived Read Models

ClickHouse `analytics.*` contains rebuildable derived tables. These tables are
not source of truth and may be dropped or rebuilt from Postgres `fitness.*` raw
tables through ClickHouse replication.

| Table | Purpose |
|-------|---------|
| `analytics.deduped_sensor` | Activity-agnostic best scalar sensor sample per user, channel, and timestamp for stream and zone reads. |
| `analytics.activity_summary` | Pre-computed per-activity aggregates (avg/max HR, power, GPS distance, elevation) from deduped sensor samples. |
| `analytics.activity_trend_daily` | Daily activity trend rollup from deduped sensor samples; weekly trend endpoints roll this up at query time. |
| `analytics.activity_training_summary` | Per-activity training summary and histograms used by app analytics. |
| `analytics.activity_rollup_dirty` | Work queue for activity projection refresh. |

### Other Tables

| Table | Purpose |
|-------|---------|
| `fitness.strength_workout` | Workout sessions |
| `fitness.strength_set` | Individual sets (exercise, weight, reps, RPE) |
| `fitness.sleep_session` | Sleep sessions with nullable provider-reported measurements and an explicit `staging_available` quality flag; see the [historical repair runbook](sleep-quality-backfill-runbook.md) |
| `fitness.food_entry` | Raw food items and nutrition samples, including their ingestion grain |
| `fitness.food_entry_nutrient` | Row-based food-entry nutrient amounts |
| `fitness.supplement` | Stable per-user supplement schedule identity, ownership, and display order |
| `fitness.supplement_definition` | Immutable effective-dated supplement definition versions |
| `fitness.supplement_definition_nutrient` | Canonical row-based nutrient amounts for a definition version |
| `fitness.supplement_dose_event` | Append-only planned/taken/skipped/unknown occurrence history with provider provenance |
| `fitness.v_supplement_dose_current` | Current leaf for each supplement occurrence event chain |
| `fitness.v_nutrition_provider_daily` | Raw per-provider daily nutrient totals for provenance and provider inspection |
| `fitness.v_nutrition_daily_resolution` | Per-user/date canonical contribution decision and selected/excluded source provenance |
| `fitness.v_nutrition_canonical_nutrient` | Nutrient rows from the resolved contribution set |
| `fitness.v_nutrition_daily` | Canonical daily totals; overlapping ambiguous sources produce explicit unavailable rows |
| `fitness.v_nutrition_display_entry` | Itemized entries shown as editable food cards; aggregate samples remain raw provider data |
| `fitness.lab_result` | Clinical lab results (from Apple Health / FHIR) |
| `fitness.health_event` | Generic health events catch-all |
| `fitness.journal_entry` | Daily behavioral self-reports (WHOOP journal, etc.) |
| `fitness.life_events` | Life event markers (travel, illness, etc.), optionally linked to a personal experiment without duplicating annotation text |
| `fitness.personal_experiment` | User-authored N-of-1 setup and stop status; schedule and analysis fields are derived |
| `fitness.personal_experiment_check_in` | One raw adherence/confounder/note check-in per experiment local date; derived outcome data is never stored |

Supplement schedule, definition, nutrient, and dose-event ownership is defined
by the [canonical Drizzle schema](../src/db/schema/nutrition.ts) and introduced
by [migration 0061](../drizzle/0061_supplement_dose_events.sql).

### Daily Nutrition vs Food Entries

`fitness.food_entry` plus `fitness.food_entry_nutrient` is the raw source of truth
for nutrition. `food_entry.nutrition_grain` records whether a writer supplied
itemized foods or a daily aggregate. Existing rows remain nullable and are
classified conservatively from their stored shape rather than rewritten.
Providers that have itemized foods store named food entries. Providers that
only have nutrient samples store unnamed food entries with timestamps/source
metadata and nutrient rows.

**Apple Health** provides numerical `HKQuantitySample` records with units,
timestamps, and source revision metadata. Dofek's nutrition import has no
itemized food identity for those samples, so they become unnamed
`daily_aggregate` food entries with associated nutrient rows. See Apple's
[`HKQuantitySample`](https://developer.apple.com/documentation/healthkit/hkquantitysample),
[`HKSample`](https://developer.apple.com/documentation/healthkit/hksample), and
[`HKSourceRevision`](https://developer.apple.com/documentation/healthkit/hksourcerevision)
documentation.

**Cronometer CSV** writes `itemized` foods into `food_entry` and
`food_entry_nutrient`. Daily totals are derived from those rows instead of
inserted separately.

**FatSecret** and manual food logging write `itemized`
entries through the normalized food path. Supplement schedules do not create
food entries. Their nutrients enter
`fitness.v_nutrition_canonical_nutrient` only while the current dose-event
leaf is explicitly `taken`; planned, skipped, and unknown leaves contribute
nothing. The append-only chain uses unique and foreign-key constraints rather
than rewriting history, following PostgreSQL's documented
[constraint semantics](https://www.postgresql.org/docs/current/ddl-constraints.html).

Serving code reads `fitness.v_nutrition_daily` and
`fitness.v_nutrition_canonical_nutrient`. A single itemized source is selected
over overlapping aggregate sources. A single aggregate source is usable by
itself. Multiple independently itemized sources, multiple aggregate sources
without an itemized source, or mixed ambiguous legacy rows return
`source_conflict` with null totals and selected/excluded provenance rather than
silently double-counting or choosing by row order. PostgreSQL views provide
these query-time projections without duplicating raw storage; see
[PostgreSQL `CREATE VIEW`](https://www.postgresql.org/docs/current/sql-createview.html).

Provider details, provider statistics, and exports continue to use raw
`food_entry` / `food_entry_nutrient` data. Aggregate-only rows are excluded from
editable unnamed food cards, but are not deleted.

The installed-client `supplements.list` and `supplements.save` procedures keep
their original V1 definition-only success and error shapes. Definition-version
identity remains internal to that permanent projection. The additive
`supplements.occurrences` and `supplements.recordDose` procedures expose
current event IDs and history for newer clients; no mobile persisted-cache
contract bump is required because the persisted V1 payload did not change.

## Deduplication

All provider-sourced tables have a `(provider_id, external_id)` unique index. Syncs use upsert to avoid duplicates.

Every metric-stream ingestion path must publish Redpanda events with a stable `external_id`. Provider-supplied IDs are preferred; when the source does not expose a sample ID, ingestion derives a deterministic ID from provider, activity/source, channel, and timestamp. Metric stream events use `(user_id, provider_id, external_id, channel, recorded_at)` as the logical idempotency key so failed syncs can be retried without duplicating raw samples in ClickHouse.

Daily metrics use per-category dedup priority (see `src/db/dedup.ts`) to prefer the most accurate source for each metric when multiple providers report the same data.

Sensor sample dedup: ClickHouse selects one scalar sample per
`(user_id, channel, recorded_at)` key using sensor provider and device priority
tables with deterministic tie-breakers. Activity queries apply their own time
windows afterward; sample counts per activity do not choose the winning source.
