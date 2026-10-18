INSERT INTO fitness.device_priority (
  provider_id,
  source_name_pattern,
  priority
)
VALUES ('apple_health', 'Zepp', 1)
ON CONFLICT (provider_id, source_name_pattern) DO UPDATE SET
  priority = excluded.priority;
--> statement-breakpoint
-- Preserve non-activity fallback priorities when lowering activity priority.
INSERT INTO fitness.provider_priority AS existing_priority (
  provider_id,
  priority,
  sleep_priority,
  body_priority,
  recovery_priority,
  daily_activity_priority
)
VALUES ('amazfit-zepp', 1, 100, 100, 100, 100)
ON CONFLICT (provider_id) DO UPDATE SET
  priority = excluded.priority,
  sleep_priority = COALESCE(existing_priority.sleep_priority, existing_priority.priority),
  body_priority = COALESCE(existing_priority.body_priority, existing_priority.priority),
  recovery_priority = COALESCE(existing_priority.recovery_priority, existing_priority.priority),
  daily_activity_priority = COALESCE(existing_priority.daily_activity_priority, existing_priority.priority);
