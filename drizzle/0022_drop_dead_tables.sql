-- Drop tables that have no writers or readers in production code.
-- Audit details: all five tables are either empty on production or never
-- existed on production. See git history for the audit that identified them.

-- Defensive: if a stale provider_stats matview still references
-- fitness.nutrition_daily (pre-0013 state), drop it. The canonical
-- definition in drizzle/_views/07_provider_stats.sql reads from
-- v_nutrition_daily and will be reinstalled on next view refresh.
DROP MATERIALIZED VIEW IF EXISTS fitness.provider_stats;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.nutrition_daily;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.training_export_watermark;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.location_sample;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.inertial_measurement_unit_sample;
--> statement-breakpoint

DROP TABLE IF EXISTS fitness.orientation_sample;
