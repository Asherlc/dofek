WITH pivoted AS (
  SELECT
    ds.recorded_at,
    MAX(ds.scalar) FILTER (WHERE ds.channel = 'heart_rate')::SMALLINT AS heart_rate,
    MAX(ds.scalar) FILTER (WHERE ds.channel = 'power')::SMALLINT AS power,
    MAX(ds.scalar) FILTER (WHERE ds.channel = 'speed') AS speed,
    MAX(ds.scalar) FILTER (WHERE ds.channel = 'cadence')::SMALLINT AS cadence,
    MAX(ds.scalar) FILTER (WHERE ds.channel = 'altitude') AS altitude,
    MAX(ds.scalar) FILTER (WHERE ds.channel = 'lat') AS lat,
    MAX(ds.scalar) FILTER (WHERE ds.channel = 'lng') AS lng
  FROM fitness.deduped_sensor ds
  WHERE ds.activity_id = {{activityId}}
    AND ds.user_id = {{userId}}
    AND ds.channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude', 'lat', 'lng')
    AND EXISTS (
      SELECT 1
      FROM fitness.v_activity a
      WHERE a.id = {{activityId}}
        AND a.user_id = {{userId}}
        {{accessPredicate}}
    )
  GROUP BY ds.recorded_at
),
numbered AS (
  SELECT
    p.*,
    ROW_NUMBER() OVER (ORDER BY p.recorded_at) AS rn,
    COUNT(*) OVER () AS total
  FROM pivoted p
)
SELECT
  recorded_at::text AS recorded_at,
  heart_rate,
  power,
  speed,
  cadence,
  altitude,
  lat,
  lng
FROM numbered
WHERE rn % GREATEST(1, total / {{maxPoints}}) = 0
ORDER BY recorded_at
