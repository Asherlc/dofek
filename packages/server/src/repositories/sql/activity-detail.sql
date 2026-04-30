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
  NULL::double precision AS avg_hr,
  NULL::smallint AS max_hr,
  NULL::double precision AS avg_power,
  NULL::smallint AS max_power,
  NULL::double precision AS avg_speed,
  NULL::double precision AS max_speed,
  NULL::double precision AS avg_cadence,
  NULL::double precision AS total_distance,
  NULL::double precision AS elevation_gain_m,
  NULL::double precision AS elevation_loss_m,
  NULL::integer AS sample_count
FROM fitness.v_activity a
WHERE a.id = {{activityId}}
  AND a.user_id = {{userId}}
  {{accessPredicate}}
