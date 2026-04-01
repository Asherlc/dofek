-- Harden user scoping at the DB layer: external IDs must be unique per user.

ALTER TABLE fitness.nutrition_daily DROP CONSTRAINT IF EXISTS nutrition_daily_pkey;
ALTER TABLE fitness.nutrition_daily
  ADD CONSTRAINT nutrition_daily_pkey PRIMARY KEY (user_id, date, provider_id);

--> statement-breakpoint

DROP INDEX IF EXISTS fitness.body_measurement_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS body_measurement_provider_external_idx
  ON fitness.body_measurement USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.strength_workout_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS strength_workout_provider_external_idx
  ON fitness.strength_workout USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.activity_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS activity_provider_external_idx
  ON fitness.activity USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.sleep_session_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sleep_session_provider_external_idx
  ON fitness.sleep_session USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.food_entry_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS food_entry_provider_external_idx
  ON fitness.food_entry USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.lab_panel_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS lab_panel_provider_external_idx
  ON fitness.lab_panel USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.lab_result_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS lab_result_provider_external_idx
  ON fitness.lab_result USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.medication_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS medication_provider_external_idx
  ON fitness.medication USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.condition_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS condition_provider_external_idx
  ON fitness.condition USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.allergy_intolerance_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS allergy_intolerance_provider_external_idx
  ON fitness.allergy_intolerance USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.medication_dose_event_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS medication_dose_event_provider_external_idx
  ON fitness.medication_dose_event USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.health_event_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS health_event_provider_external_idx
  ON fitness.health_event USING btree (user_id, provider_id, external_id);

DROP INDEX IF EXISTS fitness.dexa_scan_provider_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS dexa_scan_provider_external_idx
  ON fitness.dexa_scan USING btree (user_id, provider_id, external_id);
