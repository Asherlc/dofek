-- Add WHOOP data fields that were previously discarded during sync:
-- Sleep need breakdown, percent recorded, MSK strain, strap location, exercise metadata

-- Sleep need breakdown (WHOOP's proprietary sleep need model)
ALTER TABLE fitness.sleep_session ADD COLUMN sleep_need_baseline_minutes integer;
ALTER TABLE fitness.sleep_session ADD COLUMN sleep_need_from_debt_minutes integer;
ALTER TABLE fitness.sleep_session ADD COLUMN sleep_need_from_strain_minutes integer;
ALTER TABLE fitness.sleep_session ADD COLUMN sleep_need_from_nap_minutes integer;

-- Percent of workout that was recorded by the sensor
ALTER TABLE fitness.activity ADD COLUMN percent_recorded real;

-- MSK strain breakdown on strength workouts
ALTER TABLE fitness.strength_workout ADD COLUMN raw_msk_strain_score real;
ALTER TABLE fitness.strength_workout ADD COLUMN scaled_msk_strain_score real;
ALTER TABLE fitness.strength_workout ADD COLUMN cardio_strain_score real;
ALTER TABLE fitness.strength_workout ADD COLUMN cardio_strain_contribution_percent real;
ALTER TABLE fitness.strength_workout ADD COLUMN msk_strain_contribution_percent real;

-- Strap location on strength sets (PushCore strap body placement)
ALTER TABLE fitness.strength_set ADD COLUMN strap_location text;
ALTER TABLE fitness.strength_set ADD COLUMN strap_location_laterality text;

-- Exercise metadata from WHOOP exercise catalog
ALTER TABLE fitness.exercise ADD COLUMN muscle_groups text[];
ALTER TABLE fitness.exercise ADD COLUMN exercise_type text;
