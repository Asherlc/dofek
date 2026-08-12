INSERT INTO fitness.device_priority (
  provider_id,
  source_name_pattern,
  priority,
  sleep_priority,
  body_priority,
  recovery_priority,
  daily_activity_priority
)
VALUES ('apple_health', 'Hang Ten', 10, NULL, NULL, NULL, NULL)
ON CONFLICT (provider_id, source_name_pattern) DO UPDATE SET
  priority = excluded.priority;
