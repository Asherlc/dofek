INSERT INTO fitness.device_priority (
  provider_id,
  source_name_pattern,
  priority
)
VALUES ('apple_health', 'Hang Ten', 20)
ON CONFLICT (provider_id, source_name_pattern) DO UPDATE SET
  priority = excluded.priority;
