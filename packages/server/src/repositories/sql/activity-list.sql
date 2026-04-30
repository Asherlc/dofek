SELECT
  a.id,
  a.activity_type,
  a.started_at::text AS started_at,
  a.ended_at::text AS ended_at,
  a.name,
  a.provider_id,
  a.source_providers,
  NULL::double precision AS avg_hr,
  NULL::smallint AS max_hr,
  NULL::double precision AS avg_power,
  NULL::double precision AS distance_meters,
  COUNT(*) OVER()::int AS total_count
FROM fitness.v_activity a
WHERE a.user_id = {{userId}}
  AND a.started_at > {{startedAfter}}
  {{typeFilter}}
  {{accessPredicate}}
ORDER BY a.started_at DESC
LIMIT {{limit}} OFFSET {{offset}}
