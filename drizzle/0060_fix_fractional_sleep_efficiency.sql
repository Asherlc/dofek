-- Fix sleep efficiency values stored as fractions (0-1) instead of percentages (0-100).
-- WHOOP's in_sleep_efficiency field can return fractions; our parsing now normalizes
-- them, but existing rows need correction.

UPDATE fitness.sleep_session
SET efficiency_pct = ROUND((efficiency_pct * 100)::numeric, 1)
WHERE efficiency_pct > 0
  AND efficiency_pct <= 1.0;

--> statement-breakpoint

REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_sleep;
