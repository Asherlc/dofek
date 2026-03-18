# Database Schema

All tables live in the `fitness` Postgres schema. The source of truth is `src/db/schema.ts` (Drizzle generates migrations from it).

## Data Model Philosophy: Raw Data Only

We only store raw, non-derivable data. If a value can be computed from other stored data, it should not have its own column. This keeps the schema honest and avoids stale or inconsistent derived values.

### What counts as "raw"

A column is raw if the data originates from a sensor or external system and **cannot** be recomputed from other columns we store.

### Columns we intentionally do NOT store

| Removed column | Why it's derivable |
|---|---|
| `metric_stream.distance` | **Outdoor**: computable from GPS lat/lng via haversine. **Indoor** (trainer/treadmill): synthetic — computed from virtual speed models, not a real measurement. |
| `metric_stream.calories` | Device-computed from HR, power, body weight, and proprietary algorithms. Not a direct sensor reading. |
| `activity_interval.avg_heart_rate` | Computable from `metric_stream.heart_rate` within the interval's time range. |
| `activity_interval.max_heart_rate` | Same — `MAX(heart_rate)` over the interval window. |
| `activity_interval.avg_power` | Same — `AVG(power)` over the interval window. |
| `activity_interval.max_power` | Same — `MAX(power)` over the interval window. |
| `activity_interval.avg_speed` | Same — `AVG(speed)` over the interval window. |
| `activity_interval.max_speed` | Same — `MAX(speed)` over the interval window. |
| `activity_interval.avg_cadence` | Same — `AVG(cadence)` over the interval window. |
| `activity_interval.distance_meters` | Same — computed from GPS within the interval. |
| `activity_interval.elevation_gain` | Same — computed from altitude deltas within the interval. |

The `activity_summary` materialized view computes all of these at refresh time from `metric_stream` data, including total distance (haversine over GPS points) and elevation gain/loss (altitude deltas).

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

#### `metric_stream` (what remains)

| Column | Why it's raw |
|---|---|
| `heart_rate` | Direct sensor reading (optical PPG or chest strap ECG). |
| `power` | Direct measurement from power meter strain gauges. |
| `cadence` | Direct measurement from accelerometer/magnet sensor. |
| `speed` | From GPS Doppler or wheel speed sensor. |
| `lat`, `lng` | GPS coordinates from GNSS receiver. |
| `altitude` | Barometric altimeter or GPS altitude. |
| `temperature` | Ambient temperature sensor. |
| `grade` | Road grade from GPS + altimeter. Kept because it's provider-reported and not trivially derivable from noisy GPS altitude. |
| `vertical_speed` | Barometric rate of climb. Provider-specific smoothing makes it non-trivial to recompute. |
| `spo2` | Pulse oximeter reading during activity. |
| `respiratory_rate` | Breath rate sensor. |
| `gps_accuracy` | GNSS receiver's estimated position error. |
| `accumulated_power` | Running sum from power meter firmware. Kept for TSS/kJ calculations that need firmware-level precision. |
| Running dynamics (`stance_time`, `vertical_oscillation`, etc.) | Direct IMU/accelerometer measurements from running pods or watches. |
| Pedal dynamics (`left_torque_effectiveness`, etc.) | Direct measurements from dual-sided power meters. |

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
| `fitness.activity_interval` | Laps/intervals with time ranges (metrics computed at query time from metric_stream) |
| `fitness.metric_stream` | Second-by-second sensor data (hypertable) — HR, power, cadence, speed, GPS, altitude |

### Daily Metrics

| Table | Purpose |
|-------|---------|
| `fitness.daily_metrics` | Device-reported daily health data — RHR, HRV, steps, SpO2, walking biomechanics |

### Materialized Views

| View | Purpose |
|------|---------|
| `fitness.activity_summary` | Pre-computed per-activity aggregates (avg/max HR, power, GPS distance, elevation) from metric_stream |

### Other Tables

| Table | Purpose |
|-------|---------|
| `fitness.body_measurement` | Weight, body fat %, muscle mass, BMI |
| `fitness.strength_workout` | Workout sessions |
| `fitness.strength_set` | Individual sets (exercise, weight, reps, RPE) |
| `fitness.sleep_session` | Sleep sessions with stage breakdown |
| `fitness.nutrition_daily` | Daily macros — calories, protein, carbs, fat, fiber, water |
| `fitness.food_entry` | Individual food items with full macro/micronutrient data |
| `fitness.lab_result` | Clinical lab results (from Apple Health / FHIR) |
| `fitness.health_event` | Generic health events catch-all |
| `fitness.journal_entry` | Daily behavioral self-reports (WHOOP journal, etc.) |
| `fitness.life_events` | Life event markers (travel, illness, etc.) |

## Deduplication

All provider-sourced tables have a `(provider_id, external_id)` unique index. Syncs use upsert to avoid duplicates.

Daily metrics use per-category dedup priority (see `src/sync/dedup.ts`) to prefer the most accurate source for each metric when multiple providers report the same data.
