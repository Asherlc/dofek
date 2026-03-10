# Database Schema

All tables live in the `fitness` Postgres schema. The source of truth is `src/db/schema.ts` (Drizzle generates migrations from it).

## Tables

### Reference

| Table | Purpose |
|-------|---------|
| `fitness.provider` | Registered data sources (hevy, wahoo, etc.) |
| `fitness.exercise` | Canonical exercise library (provider-agnostic) |
| `fitness.exercise_alias` | Maps provider-specific exercise names to canonical exercises |

### Body Composition

| Table | Purpose |
|-------|---------|
| `fitness.body_measurement` | Weight, body fat %, muscle mass, BMI, hydration (hypertable) |

### Strength Training

| Table | Purpose |
|-------|---------|
| `fitness.strength_workout` | Workout sessions (name, time, notes) |
| `fitness.strength_set` | Individual sets (exercise, weight, reps, RPE, set type) |

### Activities

| Table | Purpose |
|-------|---------|
| `fitness.activity` | Any timed activity — cardio, strength, yoga, meditation, etc. (type, times, raw JSONB summary) |
| `fitness.activity_stream` | Second-by-second sensor data (hypertable) — HR, power, cadence, speed, GPS |

### Daily Metrics

| Table | Purpose |
|-------|---------|
| `fitness.daily_metrics` | Computed training metrics — CTL, ATL, TSB, eFTP, HRV |

### Sleep

| Table | Purpose |
|-------|---------|
| `fitness.sleep_session` | Sleep sessions with stage breakdown (hypertable) |

### Nutrition

| Table | Purpose |
|-------|---------|
| `fitness.nutrition_daily` | Daily macros — calories, protein, carbs, fat, fiber, water |

## Hypertables

Three tables use TimescaleDB hypertables for time-series performance:

- `fitness.body_measurement` — partitioned on `recorded_at`
- `fitness.activity_stream` — partitioned on `recorded_at`
- `fitness.sleep_session` — partitioned on `started_at`

## Deduplication

All provider-sourced tables have a `(provider_id, external_id)` unique index. Syncs use upsert to avoid duplicates.
