SELECT
  a.id,
  a.activity_type,
  a.started_at::text AS started_at,
  a.ended_at::text AS ended_at,
  a.name,
  a.provider_id,
  a.source_providers,
  s.avg_hr,
  s.max_hr,
  s.avg_power,
  s.total_distance AS distance_meters,
  COUNT(*) OVER()::int AS total_count
FROM fitness.v_activity a
LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
WHERE a.user_id = {{userId}}
  AND a.started_at > {{startedAfter}}
  {{typeFilter}}
  {{accessPredicate}}
ORDER BY a.started_at DESC
LIMIT {{limit}} OFFSET {{offset}}
