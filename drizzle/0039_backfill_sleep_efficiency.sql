-- Backfill efficiency_pct for sleep sessions that have stage data but no efficiency.
-- This fixes HealthKit-synced sessions (efficiency was never set) and Apple Health
-- XML imports (efficiency was stored as 0-1 fraction instead of 0-100 percentage).

-- 1. Backfill NULL efficiency from stage minutes
UPDATE fitness.sleep_session
SET efficiency_pct = ROUND(
  (COALESCE(deep_minutes, 0) + COALESCE(rem_minutes, 0) + COALESCE(light_minutes, 0))::numeric
  / NULLIF(duration_minutes, 0) * 100,
  1
)
WHERE efficiency_pct IS NULL
  AND duration_minutes > 0;

-- 2. Fix fractional efficiency values from Apple Health XML import (stored as 0-1 instead of 0-100)
-- Any efficiency_pct <= 1.0 is almost certainly a fraction that needs rescaling
UPDATE fitness.sleep_session
SET efficiency_pct = ROUND(efficiency_pct * 100, 1)
WHERE efficiency_pct > 0
  AND efficiency_pct <= 1.0;

-- 3. Refresh the materialized view so v_sleep picks up the corrected values
REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_sleep;
