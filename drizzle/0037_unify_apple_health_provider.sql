-- Consolidate apple_health_kit provider into apple_health.
-- Both are ingestion paths for the same Apple Watch data:
--   apple_health  = XML export import
--   apple_health_kit = live iOS HealthKit sync
-- After this migration, both paths use provider_id = 'apple_health'.

-- 1. daily_metrics: merge rows where both providers have data for the same date.
--    Prefer existing apple_health values (from full XML export) over apple_health_kit.
UPDATE fitness.daily_metrics ahk
SET provider_id = 'apple_health',
    resting_hr           = COALESCE(ah.resting_hr,           ahk.resting_hr),
    hrv                  = COALESCE(ah.hrv,                  ahk.hrv),
    vo2max               = COALESCE(ah.vo2max,               ahk.vo2max),
    spo2_avg             = COALESCE(ah.spo2_avg,             ahk.spo2_avg),
    respiratory_rate_avg = COALESCE(ah.respiratory_rate_avg,  ahk.respiratory_rate_avg),
    steps                = COALESCE(ah.steps,                 ahk.steps),
    active_energy_kcal   = COALESCE(ah.active_energy_kcal,   ahk.active_energy_kcal),
    basal_energy_kcal    = COALESCE(ah.basal_energy_kcal,    ahk.basal_energy_kcal),
    distance_km          = COALESCE(ah.distance_km,          ahk.distance_km),
    cycling_distance_km  = COALESCE(ah.cycling_distance_km,  ahk.cycling_distance_km),
    flights_climbed      = COALESCE(ah.flights_climbed,       ahk.flights_climbed),
    exercise_minutes     = COALESCE(ah.exercise_minutes,      ahk.exercise_minutes),
    mindful_minutes      = COALESCE(ah.mindful_minutes,       ahk.mindful_minutes),
    walking_speed        = COALESCE(ah.walking_speed,         ahk.walking_speed),
    walking_step_length  = COALESCE(ah.walking_step_length,   ahk.walking_step_length),
    walking_double_support_pct = COALESCE(ah.walking_double_support_pct, ahk.walking_double_support_pct),
    walking_asymmetry_pct = COALESCE(ah.walking_asymmetry_pct, ahk.walking_asymmetry_pct),
    walking_steadiness   = COALESCE(ah.walking_steadiness,    ahk.walking_steadiness),
    stand_hours          = COALESCE(ah.stand_hours,           ahk.stand_hours),
    environmental_audio_exposure = COALESCE(ah.environmental_audio_exposure, ahk.environmental_audio_exposure),
    headphone_audio_exposure     = COALESCE(ah.headphone_audio_exposure,     ahk.headphone_audio_exposure),
    skin_temp_c          = COALESCE(ah.skin_temp_c,           ahk.skin_temp_c),
    stress_high_minutes  = COALESCE(ah.stress_high_minutes,   ahk.stress_high_minutes),
    recovery_high_minutes = COALESCE(ah.recovery_high_minutes, ahk.recovery_high_minutes),
    resilience_level     = COALESCE(ah.resilience_level,      ahk.resilience_level),
    source_name          = COALESCE(ah.source_name,           ahk.source_name)
FROM fitness.daily_metrics ah
WHERE ahk.provider_id = 'apple_health_kit'
  AND ah.provider_id = 'apple_health'
  AND ah.date = ahk.date
  AND ah.user_id = ahk.user_id;

-- Delete apple_health_kit rows that were merged into existing apple_health rows
DELETE FROM fitness.daily_metrics ahk
USING fitness.daily_metrics ah
WHERE ahk.provider_id = 'apple_health_kit'
  AND ah.provider_id = 'apple_health'
  AND ah.date = ahk.date
  AND ah.user_id = ahk.user_id;

-- Remaining apple_health_kit daily_metrics rows (dates with no apple_health row): just rename
UPDATE fitness.daily_metrics
SET provider_id = 'apple_health'
WHERE provider_id = 'apple_health_kit';

-- 2. Tables with (provider_id, external_id) unique constraint — no conflicts
--    because XML and HealthKit use different external_id formats.
UPDATE fitness.activity SET provider_id = 'apple_health' WHERE provider_id = 'apple_health_kit';
UPDATE fitness.body_measurement SET provider_id = 'apple_health' WHERE provider_id = 'apple_health_kit';
UPDATE fitness.sleep_session SET provider_id = 'apple_health' WHERE provider_id = 'apple_health_kit';
UPDATE fitness.health_event SET provider_id = 'apple_health' WHERE provider_id = 'apple_health_kit';

-- 3. metric_stream — no unique constraint, safe to rename
UPDATE fitness.metric_stream SET provider_id = 'apple_health' WHERE provider_id = 'apple_health_kit';

-- 4. Clean up priority tables
DELETE FROM fitness.device_priority WHERE provider_id = 'apple_health_kit';
DELETE FROM fitness.provider_priority WHERE provider_id = 'apple_health_kit';

-- 5. Delete the apple_health_kit provider row
DELETE FROM fitness.provider WHERE id = 'apple_health_kit';
