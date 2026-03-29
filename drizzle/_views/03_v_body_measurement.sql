-- Canonical definition of the fitness.v_body_measurement materialized view.

CREATE MATERIALIZED VIEW fitness.v_body_measurement AS
WITH RECURSIVE ranked AS (
  SELECT
    b.*,
    COALESCE(dp.body_priority, pp.body_priority, dp.priority, pp.priority, 100) AS prio
  FROM fitness.body_measurement b
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = b.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.body_priority, dp2.priority
    FROM fitness.device_priority dp2
    WHERE dp2.provider_id = b.provider_id
      AND b.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) dp ON true
),
pairs AS (
  SELECT r1.id AS id1, r2.id AS id2
  FROM ranked r1
  JOIN ranked r2
    ON r1.id < r2.id
    AND r1.user_id = r2.user_id
    AND ABS(EXTRACT(EPOCH FROM (r1.recorded_at - r2.recorded_at))) < 300
),
edges AS (
  SELECT id1 AS a, id2 AS b FROM pairs
  UNION ALL
  SELECT id2 AS a, id1 AS b FROM pairs
),
clusters(measurement_id, group_id) AS (
  SELECT id, id::text FROM ranked
  UNION
  SELECT e.b, c.group_id
  FROM edges e
  JOIN clusters c ON c.measurement_id = e.a
),
final_groups AS (
  SELECT measurement_id, MIN(group_id) AS group_id FROM clusters GROUP BY measurement_id
),
best AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.id AS canonical_id,
    r.provider_id,
    r.user_id,
    r.recorded_at,
    r.prio
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.measurement_id
  ORDER BY fg.group_id, r.prio ASC, r.id ASC
)
SELECT
  b.canonical_id AS id,
  b.provider_id,
  b.user_id,
  b.recorded_at,
  (SELECT r.weight_kg FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.weight_kg IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS weight_kg,
  (SELECT r.body_fat_pct FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.body_fat_pct IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS body_fat_pct,
  (SELECT r.muscle_mass_kg FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.muscle_mass_kg IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS muscle_mass_kg,
  (SELECT r.bmi FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.bmi IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS bmi,
  (SELECT r.systolic_bp FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.systolic_bp IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS systolic_bp,
  (SELECT r.diastolic_bp FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.diastolic_bp IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS diastolic_bp,
  (SELECT r.temperature_c FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.temperature_c IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS temperature_c,
  (SELECT r.height_cm FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.height_cm IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS height_cm,
  (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id) FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id) AS source_providers
FROM best b
ORDER BY b.recorded_at DESC;

--> statement-breakpoint

CREATE UNIQUE INDEX v_body_measurement_id_idx ON fitness.v_body_measurement (id);
CREATE INDEX v_body_measurement_time_idx ON fitness.v_body_measurement (recorded_at DESC);
