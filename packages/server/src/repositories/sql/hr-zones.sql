WITH params AS (
  SELECT
    up.max_hr,
    COALESCE(rhr.resting_hr, 60) AS resting_hr
  FROM fitness.user_profile up
  LEFT JOIN {{restingHeartRateLateral}}
  WHERE up.id = {{userId}}
    AND up.max_hr IS NOT NULL
),
hr_samples AS (
  SELECT ds.scalar AS heart_rate
  FROM fitness.deduped_sensor ds
  WHERE ds.activity_id = {{activityId}}
    AND ds.user_id = {{userId}}
    AND ds.channel = 'heart_rate'
    AND EXISTS (
      SELECT 1
      FROM fitness.v_activity a
      WHERE a.id = {{activityId}}
        AND a.user_id = {{userId}}
        {{accessPredicate}}
    )
)
SELECT
  z.zone,
  COUNT(hs.heart_rate)::int AS seconds
FROM params p
CROSS JOIN (VALUES (1), (2), (3), (4), (5)) AS z(zone)
LEFT JOIN hr_samples hs ON
  CASE z.zone
    WHEN 1 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.5
      AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.6
    WHEN 2 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.6
      AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.7
    WHEN 3 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.7
      AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.8
    WHEN 4 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.8
      AND hs.heart_rate < p.resting_hr + (p.max_hr - p.resting_hr) * 0.9
    WHEN 5 THEN hs.heart_rate >= p.resting_hr + (p.max_hr - p.resting_hr) * 0.9
  END
GROUP BY z.zone
ORDER BY z.zone
