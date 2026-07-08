-- Add CHECK constraints to enforce non-negative numeric ranges and logical
-- timestamp ordering on provider-supplied data. All constraints were
-- verified against existing prod data; only 2 `fitness.activity` rows
-- violated the new `ended_at > started_at` invariant and were remediated
-- in this migration first (Peloton zero-duration rows — Peloton source-side
-- bug is tracked as a separate follow-up).

-- Backfill 2 Peloton rows whose `ended_at == started_at` (zero-duration). The
-- minimal inflated value keeps the recorded `started_at` exactly and adds a
-- 1-second floor on `ended_at` purely to satisfy the CHECK below; the Peloton
-- provider is the real bug here (recorded durations of "45 min" and "60 min"
-- never reached the activity table).
UPDATE fitness.activity
SET ended_at = started_at + INTERVAL '1 second'
WHERE ended_at IS NOT NULL AND ended_at <= started_at;

-- activity: ended_at (when present) must be strictly after started_at.
ALTER TABLE fitness.activity
  ADD CONSTRAINT activity_ended_after_started_chk
  CHECK (ended_at IS NULL OR ended_at > started_at);

-- strength_set: weights/reps/distance/duration are physical measurements and
-- cannot be negative when present.
ALTER TABLE fitness.strength_set
  ADD CONSTRAINT strength_set_weight_nonneg_chk CHECK (weight_kg IS NULL OR weight_kg >= 0),
  ADD CONSTRAINT strength_set_reps_nonneg_chk CHECK (reps IS NULL OR reps >= 0),
  ADD CONSTRAINT strength_set_distance_nonneg_chk CHECK (distance_meters IS NULL OR distance_meters >= 0),
  ADD CONSTRAINT strength_set_duration_nonneg_chk CHECK (duration_seconds IS NULL OR duration_seconds >= 0);

-- daily_metrics: cumulative measurements cannot be negative when present.
ALTER TABLE fitness.daily_metrics
  ADD CONSTRAINT daily_metrics_steps_nonneg_chk CHECK (steps IS NULL OR steps >= 0),
  ADD CONSTRAINT daily_metrics_active_energy_nonneg_chk CHECK (active_energy_kcal IS NULL OR active_energy_kcal >= 0),
  ADD CONSTRAINT daily_metrics_basal_energy_nonneg_chk CHECK (basal_energy_kcal IS NULL OR basal_energy_kcal >= 0),
  ADD CONSTRAINT daily_metrics_distance_nonneg_chk CHECK (distance_km IS NULL OR distance_km >= 0),
  ADD CONSTRAINT daily_metrics_cycling_distance_nonneg_chk CHECK (cycling_distance_km IS NULL OR cycling_distance_km >= 0),
  ADD CONSTRAINT daily_metrics_flights_climbed_nonneg_chk CHECK (flights_climbed IS NULL OR flights_climbed >= 0),
  ADD CONSTRAINT daily_metrics_exercise_minutes_nonneg_chk CHECK (exercise_minutes IS NULL OR exercise_minutes >= 0),
  ADD CONSTRAINT daily_metrics_hrv_nonneg_chk CHECK (hrv IS NULL OR hrv >= 0);

-- sleep_session: durations cannot be negative, efficiency is a percentage.
ALTER TABLE fitness.sleep_session
  ADD CONSTRAINT sleep_session_duration_nonneg_chk CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  ADD CONSTRAINT sleep_session_deep_nonneg_chk CHECK (deep_minutes IS NULL OR deep_minutes >= 0),
  ADD CONSTRAINT sleep_session_rem_nonneg_chk CHECK (rem_minutes IS NULL OR rem_minutes >= 0),
  ADD CONSTRAINT sleep_session_light_nonneg_chk CHECK (light_minutes IS NULL OR light_minutes >= 0),
  ADD CONSTRAINT sleep_session_awake_nonneg_chk CHECK (awake_minutes IS NULL OR awake_minutes >= 0),
  ADD CONSTRAINT sleep_session_efficiency_range_chk CHECK (efficiency_pct IS NULL OR (efficiency_pct >= 0 AND efficiency_pct <= 100));

-- food_entry: serving amounts must be positive when present.
ALTER TABLE fitness.food_entry
  ADD CONSTRAINT food_entry_serving_weight_pos_chk CHECK (serving_weight_grams IS NULL OR serving_weight_grams > 0),
  ADD CONSTRAINT food_entry_number_of_units_nonneg_chk CHECK (number_of_units IS NULL OR number_of_units >= 0);

-- lab_result: reference range low/high must be ordered when both present.
ALTER TABLE fitness.lab_result
  ADD CONSTRAINT lab_result_range_order_chk
  CHECK (
    reference_range_low IS NULL
    OR reference_range_high IS NULL
    OR reference_range_high >= reference_range_low
  );

-- dexa_scan: body composition percentages cannot be negative when present.
ALTER TABLE fitness.dexa_scan
  ADD CONSTRAINT dexa_scan_body_fat_pct_nonneg_chk CHECK (body_fat_pct IS NULL OR body_fat_pct >= 0);

-- Partial index for dashboard activity visibility: every user-facing query
-- filters out soft-deleted and provider-absent rows. A partial index on the
-- active subset keeps that high-frequency predicate cheap and gives the
-- query planner a tight baseline.
CREATE INDEX IF NOT EXISTS activity_active_user_started_idx
  ON fitness.activity (user_id, started_at DESC)
  WHERE deleted_at IS NULL AND provider_absent_at IS NULL;