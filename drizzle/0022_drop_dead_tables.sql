-- Drop tables that have no writers or readers in production code.
-- Audit details: all five tables are either empty on production or never
-- existed on production. See git history for the audit that identified them.

-- Note: fitness.provider_stats was a materialized view that depended on
-- fitness.nutrition_daily in the original baseline. Migration 0013 converted
-- it to a regular view; migration 0018 redefined it to read from
-- fitness.v_nutrition_daily (the view, not the table). So by the time this
-- migration runs in any environment that has applied 0013-0018, the drop
-- below succeeds with no dependency conflicts.

DROP TABLE IF EXISTS fitness.nutrition_daily;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.training_export_watermark;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.location_sample;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.inertial_measurement_unit_sample;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.orientation_sample;
