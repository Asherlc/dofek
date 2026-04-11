-- The v_activity materialized view references percent_recorded via a.*,
-- so we must drop it before removing the column. syncMaterializedViews()
-- recreates it from the canonical definition after migrations run.
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity CASCADE;

-- Clear the stored hash so syncMaterializedViews() treats the view as new
-- and recreates it (the canonical SQL didn't change, so the hash would
-- otherwise match and skip recreation).
DELETE FROM drizzle.__view_hashes WHERE view_name = 'fitness.v_activity';

ALTER TABLE fitness.activity DROP COLUMN IF EXISTS percent_recorded;
