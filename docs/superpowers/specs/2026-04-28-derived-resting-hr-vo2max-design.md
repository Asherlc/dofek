# Derived Resting Heart Rate and VO2 Max Design

## Summary

`fitness.daily_metrics.resting_hr` and `fitness.daily_metrics.vo2max` currently store provider-reported daily values. That conflicts with the data model: resting heart rate and VO2 Max can be derived from raw heart-rate, activity, power, speed, grade, and body-weight data. Provider VO2 Max values are black-box estimates and should not be canonical.

This change removes the stored `resting_hr` and `vo2max` columns, stops ingesting provider values for those fields, and replaces consumers with derived server-side calculations. The first VO2 Max implementation derives activity-level estimates across supported activity types and returns the average of all qualifying estimates in the requested lookback window.

## Goals

- Remove `resting_hr` and `vo2max` from `fitness.daily_metrics`.
- Ignore provider VO2 Max values entirely for canonical metrics.
- Stop provider syncs from writing provider resting HR into `daily_metrics`.
- Derive resting heart rate from raw heart-rate samples.
- Derive VO2 Max from transparent public formulas using raw activity data.
- Keep all calculations server-side.
- Preserve healthspan/UI behavior where enough raw data exists.

## Non-Goals

- Do not migrate every `daily_metrics` fixed column in this change.
- Do not store derived VO2 Max or derived resting HR in replacement fixed columns.
- Do not use provider VO2 Max as fallback, calibration, or reference input.
- Do not add unsupported activity-type estimates without a defensible public equation and required inputs.
- Do not add a new broad derived-metrics framework beyond what this change needs.

## Current State

`fitness.daily_metrics` stores `resting_hr` and `vo2max` as nullable fixed columns. Providers write those values from their own APIs:

- Apple Health maps `HKQuantityTypeIdentifierRestingHeartRate` and `HKQuantityTypeIdentifierVO2Max`.
- Garmin writes resting HR from daily summaries and VO2 Max from training status.
- Oura, Ultrahuman, and Zwift can write provider VO2 Max estimates.

`fitness.v_daily_metrics` selects the first non-null value by provider priority. Healthspan then reads `resting_hr` and `vo2max` from that view. This makes black-box provider output look like raw canonical data.

## Data Model

Remove these columns from `fitness.daily_metrics`:

- `resting_hr`
- `vo2max`

Update the Drizzle schema and all canonical view definitions so `fitness.v_daily_metrics` no longer exposes those fields. Existing daily facts such as HRV, SpO2, steps, energy, distance, and respiratory rate remain unchanged.

Provider parsers can keep provider VO2 Max parsing only when an API contract test still needs to verify the external response shape. Sync and persistence code must not pass parsed provider VO2 Max into canonical tables. Remove parsed provider VO2 Max fields from internal parsed daily-metric objects when no production consumer remains.

## Derived Resting Heart Rate

Create server-side derived resting-heart-rate logic that reads raw heart-rate samples from `fitness.deduped_sensor` or `fitness.metric_stream`.

The first implementation must:

- Use heart-rate samples within sleep windows when a sleep session exists for the day.
- Compute a robust resting value from low stable samples rather than a single minimum.
- Return `null` when there is no usable sleep/rest raw HR.
- Avoid fallback to provider-reported daily resting HR.

Recommended initial calculation:

1. Join each day to that user's sleep sessions.
2. Select deduped `heart_rate` samples inside the selected sleep window.
3. Require at least 30 heart-rate samples inside the sleep window to avoid sparse artifacts.
4. Calculate the 10th percentile and round to bpm.

If the existing database image lacks `percentile_cont`, use a deterministic SQL window-rank percentile instead of adding infrastructure.

## Derived VO2 Max

Create server-side derived VO2 Max logic that computes activity-level estimates across all supported activity types where inputs are sufficient. The aggregate VO2 Max returned to consumers is:

```text
average(all qualifying activity-level VO2 Max estimates in the lookback window)
```

Each activity-level estimate must include internal provenance:

- method id
- activity id
- activity date
- activity type
- input values used
- computed VO2 Max value

The public API initially returns only the aggregate value needed by healthspan. Keep the provenance available in repository output or private helper return values so tests can verify the calculation and future UI can expose it.

### Cycling With Power

For cycling-like activity types with power data and body weight:

```text
VO2max = (best_5_min_power_watts / body_weight_kg) * 10.8 + 7
```

Inputs:

- best 5-minute power from deduped power samples for the activity
- latest body weight at or before the activity date from `fitness.v_body_measurement`

Quality filters:

- require enough power samples to cover at least five minutes
- require positive body weight
- skip activities with best five-minute power below 50 W or above 700 W
- skip activities with missing weight

### Running, Walking, and Hiking

For outdoor running, walking, and hiking activity types, use ACSM metabolic equations only when speed, grade, heart rate, user max HR, and derived resting HR are usable. These estimates use submaximal HR reserve scaling:

```text
intensity_fraction = (segment_avg_hr - derived_resting_hr) / (user_max_hr - derived_resting_hr)
VO2max = segment_oxygen_cost / intensity_fraction
```

For walking speeds, calculate segment oxygen cost with:

```text
VO2 = 0.1 * speed_m_per_min + 1.8 * speed_m_per_min * grade_fraction + 3.5
```

For running speeds, calculate segment oxygen cost with:

```text
VO2 = 0.2 * speed_m_per_min + 0.9 * speed_m_per_min * grade_fraction + 3.5
```

Use five-minute rolling segments. Classify segments with average speed below 134 m/min as walking and at or above 134 m/min as running.

Inputs:

- deduped speed samples or distance/time-derived speed
- grade from elevation and distance
- segment average heart rate
- user max HR
- derived resting HR for the activity date

Quality filters:

- require outdoor activity types: running, walking, hiking, trail running, wheelchair run, wheelchair walk
- require at least one five-minute segment with speed, grade, and heart-rate data
- require segment average HR at or above 60% HR reserve and below user max HR
- require grade between -15% and 15%
- require speed between 40 and 450 m/min
- skip treadmill, indoor, or GPS-poor activities

Unsupported activity types must be skipped, not approximated.

### Unsupported Activity Types

Activities without a public equation and required inputs are excluded from the average. This is intentional. Missing data must produce `null`, not a guessed value.

## Consumer Changes

Healthspan must stop reading `resting_hr` and `vo2max` from `fitness.v_daily_metrics`. Instead, healthspan must call derived metric logic for:

- recent/average derived resting HR
- aggregate derived VO2 Max over the healthspan lookback window

Daily metric list/trend APIs must remove stored `resting_hr` and `vo2max` fields unless they explicitly expose derived equivalents through separate code paths. The UI must not present derived values as stored provider daily facts.

Move the cycling training page VO2 Max calculation server-side so web and mobile can consume the same derived calculation.

## Migration Plan

Use a manual SQL migration because `pnpm generate` may prompt for column rename/drop decisions.

Migration responsibilities:

- Drop `fitness.v_daily_metrics` before dropping columns from `fitness.daily_metrics`.
- Drop `fitness.daily_metrics.resting_hr`.
- Drop `fitness.daily_metrics.vo2max`.
- Recreate canonical view definitions without those columns.
- Preserve existing data in unrelated columns.

After creating the migration, run `pnpm migrate`.

## Testing Plan

Use TDD. Write failing tests before implementation changes.

Required tests:

- Provider sync tests show provider VO2 Max is ignored and not persisted.
- Provider sync tests show provider resting HR is not persisted to `daily_metrics`.
- Schema/view tests show `v_daily_metrics` no longer exposes `resting_hr` or `vo2max`.
- Derived resting HR tests compute from raw sleep-window HR samples and ignore sparse/noisy data.
- Derived resting HR tests return `null` when raw rest HR is unavailable.
- Derived VO2 Max tests compute cycling power estimates from five-minute power and latest prior weight.
- Derived VO2 Max tests average all qualifying activity-level estimates in the lookback window.
- Derived VO2 Max tests skip unsupported or insufficient-data activities.
- Healthspan tests prove scores use derived values rather than removed columns.
- Integration tests run against the real database for migration/view behavior.

Before running integration tests or `pnpm test:changed`, start dependencies with:

```bash
docker compose up -d db redis
docker compose ps db redis
```

## Rollout Notes

This change intentionally removes black-box provider VO2 Max from canonical scoring. Users without enough raw heart-rate, power, speed, grade, or body-weight data may see missing resting HR or VO2 Max until enough derived inputs exist.

The final report should call out any UI or score changes caused by missing derived data.
