-- Tighten FK delete rules on parent-child relationships where CASCADE or
-- RESTRICT is the correct semantics.
--
-- lab_result.panel -> lab_panel: results are owned by their panel; deleting
--   a panel deletes its results.
-- strength_set.exercise -> exercise: deleting an exercise definition removes
--   its set rows (matches activity_interval <-> activity semantics).
-- exercise_alias.exercise -> exercise: aliases are owned by their exercise.
-- daily_metric_value.metric_type -> daily_metric_type: catalog FK; deleting
--   a metric type that is in use should be forbidden, not orphan rows.

ALTER TABLE fitness.lab_result
  DROP CONSTRAINT IF EXISTS lab_result_panel_id_fkey,
  ADD CONSTRAINT lab_result_panel_id_fkey
  FOREIGN KEY (panel_id) REFERENCES fitness.lab_panel(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE fitness.strength_set
  DROP CONSTRAINT IF EXISTS strength_set_exercise_id_exercise_id_fk,
  ADD CONSTRAINT strength_set_exercise_id_exercise_id_fk
  FOREIGN KEY (exercise_id) REFERENCES fitness.exercise(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE fitness.exercise_alias
  DROP CONSTRAINT IF EXISTS exercise_alias_exercise_id_exercise_id_fk,
  ADD CONSTRAINT exercise_alias_exercise_id_exercise_id_fk
  FOREIGN KEY (exercise_id) REFERENCES fitness.exercise(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE fitness.daily_metric_value
  DROP CONSTRAINT IF EXISTS daily_metric_value_metric_type_id_fkey,
  ADD CONSTRAINT daily_metric_value_metric_type_id_fkey
  FOREIGN KEY (metric_type_id) REFERENCES fitness.daily_metric_type(id)
  ON DELETE RESTRICT ON UPDATE NO ACTION;