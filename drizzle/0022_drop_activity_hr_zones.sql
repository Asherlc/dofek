-- ============================================================
-- Migration 0022: Drop activity_hr_zones materialized view
-- ============================================================
-- HR zone distribution is derived data (depends on user's max_hr and resting_hr
-- which change over time). Compute at query time using Karvonen (Heart Rate
-- Reserve) method with the resting HR from the time of the activity.

DROP MATERIALIZED VIEW IF EXISTS fitness.activity_hr_zones;
