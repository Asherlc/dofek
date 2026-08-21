-- The v_activity materialized view references percent_recorded via a.*,
-- so we must drop it before removing the column. syncMaterializedViews()
-- recreates it from the canonical definition after migrations run.
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity CASCADE;

-- Clear the stored hash so syncMaterializedViews() treats the view as new
-- and recreates it (the canonical SQL didn't change, so the hash would
-- otherwise match and skip recreation).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__view_hashes') THEN
    DELETE FROM drizzle.__view_hashes WHERE view_name = 'fitness.v_activity';
  END IF;
END $$;

ALTER TABLE fitness.activity DROP COLUMN IF EXISTS percent_recorded;
