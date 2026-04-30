# Database Schema

Canonical source-of-truth tables live in the `fitness` Postgres schema. The source of
truth is `src/db/schema.ts` (Drizzle generates migrations from it). Rebuildable read
models live outside `fitness`, currently in the `analytics` schema.

## Data Model Philosophy: Raw Data Only

We only store raw, non-derivable data. If a value can be computed from other stored data, it should not have its own column. This keeps the schema honest and avoids stale or inconsistent derived values.

### What counts as "raw"

A column is raw if the data originates from a sensor or external system and **cannot** be recomputed from other columns we store.

### Columns we intentionally do NOT store

| Removed column | Why it's derivable |
|---|---|
| `metric_stream.distance` | **Outdoor**: computable from GPS lat/lng via haversine. **Indoor** (trainer/treadmill): synthetic — computed from virtual speed models, not a real measurement. |
| `metric_stream.calories` | Device-computed from HR, power, body weight, and proprietary algorithms. Not a direct sensor reading. |
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

The `activity_summary` materialized view computes all of these at refresh time from `sensor_sample` data, including total distance (haversine over GPS points) and elevation gain/loss (altitude deltas).

### Columns we DO store and why they're not derivable

#### `daily_metrics`

| Column | Why it's raw |
|---|---|
| `resting_hr` | Measured by the device during sleep/rest. We don't have the raw PPG waveforms to recompute it. |
| `hrv` | RMSSD/SDNN computed from R-R intervals during sleep. We don't store beat-to-beat R-R data. |
| `vo2max` | Device-estimated from HR + speed/power during specific workouts using proprietary models (Firstbeat, etc.). Not reproducible from our data. |
| `spo2_avg` | Pulse oximeter reading. Raw infrared/red light sensor data is not stored. |
| `respiratory_rate_avg` | Derived from accelerometer + PPG during sleep. Raw sensor streams unavailable. |
| `steps` | Accelerometer-counted throughout the day. We don't store raw accelerometer data. |
| `active_energy_kcal` | Device-computed from HR, motion, body metrics across the full 24-hour day (not just activities). We lack the continuous sensor data. |
| `basal_energy_kcal` | Based on BMR formulas using body composition. The formula + inputs aren't stored. |
| `distance_km` | All-day walking/running distance from step count + stride length. Includes non-activity movement we don't track. |
| `cycling_distance_km` | All-day cycling distance, often from phone GPS during commutes. Not linked to recorded activities. |
| `flights_climbed` | Barometric altimeter counts. Raw pressure data not stored. |
| `exercise_minutes` | Device-determined from sustained HR elevation. Proprietary threshold logic. |
| `walking_speed`, `walking_step_length`, etc. | Apple Health walking analysis from phone accelerometer + gyroscope during daily walking. Raw IMU data not stored. |
| `skin_temp_c` | Skin temperature sensor (WHOOP, Oura ring). Raw thermistor data unavailable. |
| `stress_high_minutes`, `recovery_high_minutes` | Oura's proprietary stress/recovery classification from HRV + motion. |
| `resilience_level` | Oura's resilience score, proprietary algorithm. |

#### `sensor_sample` — unified time-series table

The `sensor_sample` table uses a "medium layout" — one row per (timestamp, channel) with a `scalar` column for single values and a `vector` (real[]) column for multi-axis data.

| Channel type | Example channels | Column used |
|---|---|---|
| Scalar | `heart_rate`, `power`, `cadence`, `speed`, `lat`, `lng`, `altitude`, `spo2`, etc. | `scalar` (real) |
| Vector | `imu` [x,y,z,gx,gy,gz], `accel` [x,y,z], `orientation` [w,x,y,z] | `vector` (real[]) |

**Why this layout?** Different sensors sample at different rates (GPS at 1Hz, IMU at 50Hz, HR from BLE at variable rates). The medium layout handles any sample rate without schema changes. New sensor types just add a new channel name — no migrations needed.

**Dedup strategy:** When the same metric (e.g., heart_rate) comes from multiple sources (WHOOP API at 1Hz, WHOOP BLE at 50Hz), per (activity_id, channel), the provider with the most samples wins. The most granular source is automatically preferred without any knowledge of source types.

**Ambient fallback heads up:** `analytics.deduped_sensor` uses ambient rows (`activity_id IS NULL`) as a fallback per (activity, channel) only when that activity has zero linked rows for the channel. The fallback window is bounded to `[activity.started_at, COALESCE(activity.ended_at, last_linked_sample_at)]`, where `last_linked_sample_at` is the latest linked sample timestamp for the canonical activity. Ambient rows outside this window are ignored.

**Source type:** The `source_type` column ('ble', 'file', 'api') is informational — for debugging and auditing. It is NOT used for dedup priority.

See `src/db/sensor-channels.ts` for the full list of channel constants.

## Tables

### Reference

| Table | Purpose |
|-------|---------|
| `fitness.provider` | Registered data sources (wahoo, strava, etc.) |
| `fitness.exercise` | Canonical exercise library (provider-agnostic) |
| `fitness.exercise_alias` | Maps provider-specific exercise names to canonical exercises |

### Activities

| Table | Purpose |
|-------|---------|
| `fitness.activity` | Any timed activity (type, times, raw JSONB summary from provider) |
| `fitness.activity_interval` | Laps/intervals with time ranges (metrics computed at query time from sensor_sample) |
| `fitness.sensor_sample` | Time-series sensor data (TimescaleDB hypertable) — all channels at any frequency |

### Daily Metrics

| Table | Purpose |
|-------|---------|
| `fitness.daily_metrics` | Device-reported daily health data — RHR, HRV, steps, SpO2, walking biomechanics |

### Materialized Views

Existing materialized views are not dropped or rebuilt automatically during deploy. A missing view can be created from the canonical SQL in `drizzle/_views`, but definition drift on an existing view requires explicit maintenance so production deploys do not trigger full-history rebuilds under traffic.

| View | Purpose |
|------|---------|
| `fitness.v_metric_stream` | Pivot view — presents sensor_sample in wide-row format for legacy queries |

### Continuous Aggregates

Use Timescale continuous aggregates for straightforward time-bucket rollups where the query is grouped by time and stable dimensions. Keep deduplication-heavy views as materialized views unless the data model can express the logic as an incremental Timescale aggregate.

| View | Purpose |
|------|---------|
| `fitness.cagg_metric_daily` | Daily stats per (user, metric type, source/provider) from metric_stream |
| `fitness.cagg_metric_weekly` | Weekly rollup from daily metric cagg |
| `fitness.cagg_sensor_daily` | Daily stats per (user, channel) from sensor_sample |
| `fitness.cagg_sensor_weekly` | Weekly rollup from daily cagg |

### Derived Read Models

ClickHouse `analytics.*` contains rebuildable derived tables. These tables are
not source of truth and may be dropped or rebuilt from Postgres `fitness.*` raw
tables through ClickHouse replication.

| Table | Purpose |
|-------|---------|
| `analytics.deduped_sensor` | Stored per-activity sensor sample selection for stream and zone reads. |
| `analytics.activity_summary` | Pre-computed per-activity aggregates (avg/max HR, power, GPS distance, elevation) from deduped sensor samples. |
| `analytics.activity_training_summary` | Per-activity training summary and histograms used by app analytics. |
| `analytics.activity_rollup_dirty` | Work queue for activity projection refresh. |

### Other Tables

| Table | Purpose |
|-------|---------|
| `fitness.body_measurement` | Weight, body fat %, muscle mass, BMI |
| `fitness.strength_workout` | Workout sessions |
| `fitness.strength_set` | Individual sets (exercise, weight, reps, RPE) |
| `fitness.sleep_session` | Sleep sessions with stage breakdown |
| `fitness.food_entry` | Food items and unnamed nutrition samples from providers |
| `fitness.food_entry_nutrient` | Row-based food-entry nutrient amounts |
| `fitness.supplement_nutrient` | Row-based supplement nutrient amounts |
| `fitness.v_nutrition_daily` | Daily nutrient totals derived from food-entry nutrient rows |
| `fitness.lab_result` | Clinical lab results (from Apple Health / FHIR) |
| `fitness.health_event` | Generic health events catch-all |
| `fitness.journal_entry` | Daily behavioral self-reports (WHOOP journal, etc.) |
| `fitness.life_events` | Life event markers (travel, illness, etc.) |

### Daily Nutrition vs Food Entries

`fitness.food_entry` plus `fitness.food_entry_nutrient` is the source of truth for nutrition. Providers that have itemized foods store named food entries. Providers that only have nutrient samples store unnamed food entries with timestamps/source metadata and nutrient rows.

**Apple Health** provides individual `HKQuantityType` samples (e.g., "120 calories at 12:30pm", "30g protein at 1:00pm") with source/timestamp metadata but no food name, meal type, serving size, or food identifier. These become unnamed `food_entry` rows with associated `food_entry_nutrient` rows.

**Cronometer CSV** writes itemized foods into `food_entry` and `food_entry_nutrient`. Daily totals are derived from those rows instead of inserted separately.

**FatSecret** writes itemized food entries through the same normalized path.

Routers that need daily nutrient totals query `fitness.v_nutrition_daily`. Routers that need entry-level or micronutrient detail query `food_entry` / `food_entry_nutrient` directly.

## Deduplication

All provider-sourced tables have a `(provider_id, external_id)` unique index. Syncs use upsert to avoid duplicates.

Daily metrics use per-category dedup priority (see `src/db/dedup.ts`) to prefer the most accurate source for each metric when multiple providers report the same data.

Sensor sample dedup: per (activity_id, channel), the provider with the most samples wins. This ensures the most granular source (e.g., BLE at 50Hz vs API at 1Hz) is automatically preferred.
