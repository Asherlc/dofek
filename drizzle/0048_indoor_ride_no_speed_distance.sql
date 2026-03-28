-- Originally: null out speed/distance for indoor rides in activity_summary.
-- This change is now in the canonical view definition at drizzle/_views/02_activity_summary.sql.
-- The migration runner recreates all views from canonical files after running migrations.
SELECT 1;
