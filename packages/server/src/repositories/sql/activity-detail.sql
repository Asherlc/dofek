SELECT
  a.id,
  a.activity_type,
  a.started_at::text AS started_at,
  a.ended_at::text AS ended_at,
  a.name,
  a.notes,
  a.provider_id,
  a.raw->>'sourceName' AS subsource,
  a.source_providers,
  a.source_external_ids,
  s.avg_hr,
  s.max_hr,
  s.avg_power,
  s.max_power,
  s.avg_speed,
  s.max_speed,
  s.avg_cadence,
  s.total_distance,
  s.elevation_gain_m,
  s.elevation_loss_m,
  s.sample_count
FROM fitness.v_activity a
LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
WHERE a.id = {{activityId}}
  AND a.user_id = {{userId}}
  {{accessPredicate}}
