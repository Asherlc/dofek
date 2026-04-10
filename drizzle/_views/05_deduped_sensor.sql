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
    SELECT am.canonical_id, ss.channel, ss.provider_id, COUNT(*) AS sample_count
    FROM fitness.sensor_sample ss
    JOIN activity_members am ON ss.activity_id = am.member_id
    WHERE ss.activity_id IS NOT NULL
    GROUP BY am.canonical_id, ss.channel, ss.provider_id
  ) counts
  ORDER BY canonical_id, channel, sample_count DESC
),

-- Step 2: Deduplicated scalar samples (only the winning provider per channel).
-- GROUP BY collapses any duplicate timestamps that can arise when a merge group
-- has multiple member activities from the same winning provider.
sensor_deduped AS (
  SELECT
    am.canonical_id AS activity_id,
    am.user_id,
    ss.recorded_at,
    ss.channel,
    MAX(ss.scalar) AS scalar
  FROM fitness.sensor_sample ss
  JOIN activity_members am ON ss.activity_id = am.member_id
  JOIN best_source bs
    ON am.canonical_id = bs.canonical_id
    AND ss.channel = bs.channel
    AND ss.provider_id = bs.provider_id
  WHERE ss.activity_id IS NOT NULL
    AND ss.scalar IS NOT NULL
  GROUP BY am.canonical_id, am.user_id, ss.recorded_at, ss.channel
),

-- Step 3: Pre-compute the set of canonical activities that already have sensor data.
-- This avoids re-scanning sensor_sample for every metric_stream row.
activities_with_sensors AS (
  SELECT DISTINCT am.canonical_id
  FROM fitness.sensor_sample ss
  JOIN activity_members am ON ss.activity_id = am.member_id
),

-- Step 4: During sensor backfill/cutover, keep data populated by falling back
-- to legacy metric_stream rows for activities that have not yet produced any
-- sensor_sample rows.
legacy_fallback AS (
  SELECT
    am.canonical_id AS activity_id,
    am.user_id,
    ms.recorded_at,
    expanded.channel,
    MAX(expanded.scalar) AS scalar
  FROM fitness.metric_stream ms
  JOIN activity_members am ON ms.activity_id = am.member_id
  LEFT JOIN activities_with_sensors aws ON am.canonical_id = aws.canonical_id
  CROSS JOIN LATERAL (
    VALUES
      ('heart_rate', ms.heart_rate::REAL),
      ('power', ms.power::REAL),
      ('speed', ms.speed),
      ('cadence', ms.cadence::REAL),
      ('altitude', ms.altitude),
      ('lat', ms.lat),
      ('lng', ms.lng),
      ('left_right_balance', ms.left_right_balance),
      ('left_torque_effectiveness', ms.left_torque_effectiveness),
      ('right_torque_effectiveness', ms.right_torque_effectiveness),
      ('left_pedal_smoothness', ms.left_pedal_smoothness),
      ('right_pedal_smoothness', ms.right_pedal_smoothness),
      ('stance_time', ms.stance_time),
      ('vertical_oscillation', ms.vertical_oscillation),
      ('ground_contact_time', ms.ground_contact_time),
      ('stride_length', ms.stride_length)
  ) AS expanded(channel, scalar)
  WHERE ms.activity_id IS NOT NULL
    AND expanded.scalar IS NOT NULL
    AND aws.canonical_id IS NULL
  GROUP BY am.canonical_id, am.user_id, ms.recorded_at, expanded.channel
)

SELECT * FROM sensor_deduped
UNION ALL
SELECT * FROM legacy_fallback;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS deduped_sensor_pk
  ON fitness.deduped_sensor (activity_id, channel, recorded_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deduped_sensor_activity_time_idx
  ON fitness.deduped_sensor (activity_id, recorded_at);
