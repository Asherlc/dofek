-- Canonical definition of the fitness.deduped_sensor materialized view.
-- This view depends on fitness.v_activity — it must be created after 01_v_activity.sql.
--
-- Centralizes the best-source dedup logic: for each (canonical_activity, channel),
-- picks the provider_id with the most samples. This ensures BLE data (50Hz) is
-- preferred over API data (1Hz) automatically, and cross-provider data (e.g.
-- Apple Watch HR for a Peloton ride) is included.
--
-- Downstream consumers (activity_summary, getStream, getHrZones) read from this
-- view instead of reimplementing best-source selection independently.

CREATE MATERIALIZED VIEW fitness.deduped_sensor AS

-- Step 0: Flatten v_activity to get canonical_id -> member_id mapping
WITH activity_members AS (
  SELECT a.id AS canonical_id, a.user_id, unnest(a.member_activity_ids) AS member_id
  FROM fitness.v_activity a
),

-- Step 1: For each (canonical_activity, channel), pick the provider with the most samples
best_source AS (
  SELECT DISTINCT ON (canonical_id, channel)
    canonical_id, channel, provider_id
  FROM (
    SELECT am.canonical_id, ms.channel, ms.provider_id, COUNT(*) AS sample_count
    FROM fitness.metric_stream ms
    JOIN activity_members am ON ms.activity_id = am.member_id
    WHERE ms.activity_id IS NOT NULL
    GROUP BY am.canonical_id, ms.channel, ms.provider_id
  ) counts
  ORDER BY canonical_id, channel, sample_count DESC
)

-- Step 2: Deduplicated scalar samples (only the winning provider per channel).
-- GROUP BY collapses any duplicate timestamps that can arise when a merge group
-- has multiple member activities from the same winning provider.
SELECT
  am.canonical_id AS activity_id,
  am.user_id,
  ms.recorded_at,
  ms.channel,
  MAX(ms.scalar) AS scalar
FROM fitness.metric_stream ms
JOIN activity_members am ON ms.activity_id = am.member_id
JOIN best_source bs
  ON am.canonical_id = bs.canonical_id
  AND ms.channel = bs.channel
  AND ms.provider_id = bs.provider_id
WHERE ms.activity_id IS NOT NULL
  AND ms.scalar IS NOT NULL
GROUP BY am.canonical_id, am.user_id, ms.recorded_at, ms.channel;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS deduped_sensor_pk
  ON fitness.deduped_sensor (activity_id, channel, recorded_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deduped_sensor_activity_time_idx
  ON fitness.deduped_sensor (activity_id, recorded_at);
