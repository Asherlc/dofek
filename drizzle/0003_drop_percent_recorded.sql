-- The v_activity materialized view references percent_recorded via a.*,
-- so we must drop it before removing the column. syncMaterializedViews()
-- recreates it from the canonical definition after migrations run.
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity CASCADE;

-- squawk:ignore ban-drop-column
ALTER TABLE fitness.activity DROP COLUMN IF EXISTS percent_recorded;
