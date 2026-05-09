CREATE UNIQUE INDEX IF NOT EXISTS location_sample_natural_key_idx
ON fitness.location_sample (
  user_id,
  provider_id,
  activity_id,
  recorded_at,
  latitude,
  longitude,
  source_type,
  device_id
)
NULLS NOT DISTINCT;
