-- Provider score/index fields are not observations. Remove their historical
-- values and the storage paths so future syncs cannot recreate them.
DELETE FROM fitness.health_event
WHERE type IN ('oura_daily_stress', 'oura_daily_resilience', 'oura_cardiovascular_age');

DELETE FROM fitness.daily_metric_value
WHERE metric_type_id IN ('stress_high_minutes', 'recovery_high_minutes');

DELETE FROM fitness.daily_metric_type
WHERE id IN ('stress_high_minutes', 'recovery_high_minutes');

ALTER TABLE fitness.daily_metrics
DROP COLUMN IF EXISTS stress_high_minutes,
DROP COLUMN IF EXISTS recovery_high_minutes,
DROP COLUMN IF EXISTS resilience_level;

ALTER TABLE fitness.sleep_session
DROP COLUMN IF EXISTS sleep_need_baseline_minutes,
DROP COLUMN IF EXISTS sleep_need_from_debt_minutes,
DROP COLUMN IF EXISTS sleep_need_from_strain_minutes,
DROP COLUMN IF EXISTS sleep_need_from_nap_minutes;
