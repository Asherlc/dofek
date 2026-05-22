CREATE TABLE IF NOT EXISTS fitness.sensor_provider_priority (
  provider_id text NOT NULL,
  channel text NOT NULL,
  priority bigint NOT NULL DEFAULT 1000,
  PRIMARY KEY (provider_id, channel)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fitness.sensor_device_priority (
  provider_id text NOT NULL,
  source_name_pattern text NOT NULL,
  channel text NOT NULL,
  priority bigint NOT NULL DEFAULT 1000,
  PRIMARY KEY (provider_id, source_name_pattern, channel)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fitness.provider_priority_audit (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  changed_at timestamp with time zone DEFAULT now() NOT NULL,
  changed_by text NOT NULL,
  priority_table text NOT NULL CHECK (
    priority_table IN (
      'provider_priority',
      'device_priority',
      'sensor_provider_priority',
      'sensor_device_priority'
    )
  ),
  provider_id text NOT NULL,
  source_name_pattern text,
  channel text,
  old_value jsonb,
  new_value jsonb,
  reason text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_priority_audit_changed_at_idx
ON fitness.provider_priority_audit (changed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_priority_audit_provider_idx
ON fitness.provider_priority_audit (provider_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fitness.record_provider_priority_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_provider_id text;
  changed_source_name_pattern text;
  changed_channel text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_provider_id := OLD.provider_id;
  ELSE
    changed_provider_id := NEW.provider_id;
  END IF;

  IF TG_TABLE_NAME IN ('device_priority', 'sensor_device_priority') THEN
    IF TG_OP = 'DELETE' THEN
      changed_source_name_pattern := OLD.source_name_pattern;
    ELSE
      changed_source_name_pattern := NEW.source_name_pattern;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('sensor_provider_priority', 'sensor_device_priority') THEN
    IF TG_OP = 'DELETE' THEN
      changed_channel := OLD.channel;
    ELSE
      changed_channel := NEW.channel;
    END IF;
  END IF;

  INSERT INTO fitness.provider_priority_audit (
    changed_by,
    priority_table,
    provider_id,
    source_name_pattern,
    channel,
    old_value,
    new_value,
    reason
  )
  VALUES (
    COALESCE(NULLIF(current_setting('app.changed_by', true), ''), current_user),
    TG_TABLE_NAME,
    changed_provider_id,
    changed_source_name_pattern,
    changed_channel,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    NULLIF(current_setting('app.priority_change_reason', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_priority_audit_trigger ON fitness.provider_priority;
--> statement-breakpoint
CREATE TRIGGER provider_priority_audit_trigger
AFTER INSERT OR UPDATE OR DELETE ON fitness.provider_priority
FOR EACH ROW EXECUTE FUNCTION fitness.record_provider_priority_audit();
--> statement-breakpoint
DROP TRIGGER IF EXISTS device_priority_audit_trigger ON fitness.device_priority;
--> statement-breakpoint
CREATE TRIGGER device_priority_audit_trigger
AFTER INSERT OR UPDATE OR DELETE ON fitness.device_priority
FOR EACH ROW EXECUTE FUNCTION fitness.record_provider_priority_audit();
--> statement-breakpoint
DROP TRIGGER IF EXISTS sensor_provider_priority_audit_trigger ON fitness.sensor_provider_priority;
--> statement-breakpoint
CREATE TRIGGER sensor_provider_priority_audit_trigger
AFTER INSERT OR UPDATE OR DELETE ON fitness.sensor_provider_priority
FOR EACH ROW EXECUTE FUNCTION fitness.record_provider_priority_audit();
--> statement-breakpoint
DROP TRIGGER IF EXISTS sensor_device_priority_audit_trigger ON fitness.sensor_device_priority;
--> statement-breakpoint
CREATE TRIGGER sensor_device_priority_audit_trigger
AFTER INSERT OR UPDATE OR DELETE ON fitness.sensor_device_priority
FOR EACH ROW EXECUTE FUNCTION fitness.record_provider_priority_audit();
--> statement-breakpoint
INSERT INTO fitness.provider_priority (
  provider_id,
  priority,
  sleep_priority,
  body_priority,
  recovery_priority,
  daily_activity_priority
)
VALUES
('wahoo', 10, NULL, NULL, NULL, NULL),
('oura', 80, 10, NULL, 10, 80),
('withings', 15, NULL, 10, NULL, NULL),
('peloton', 20, NULL, NULL, NULL, NULL),
('fatsecret', 25, NULL, NULL, NULL, NULL),
('whoop', 30, 20, NULL, 15, 80),
('apple_health', 90, 25, 80, 25, 15),
('garmin', 15, 40, NULL, 30, 20),
('fitbit', 50, 30, NULL, 40, 30),
('polar', 15, 50, NULL, 30, 50),
('eight_sleep', 100, 50, NULL, NULL, NULL),
('suunto', 20, 50, NULL, 40, 40),
('coros', 20, 50, NULL, 40, 40),
('strava', 40, NULL, NULL, NULL, NULL),
('ride-with-gps', 40, NULL, NULL, NULL, NULL),
('intervals', 40, NULL, NULL, NULL, NULL)
ON CONFLICT (provider_id) DO UPDATE SET
  priority = excluded.priority,
  sleep_priority = excluded.sleep_priority,
  body_priority = excluded.body_priority,
  recovery_priority = excluded.recovery_priority,
  daily_activity_priority = excluded.daily_activity_priority;
--> statement-breakpoint
INSERT INTO fitness.device_priority (
  provider_id,
  source_name_pattern,
  priority,
  sleep_priority,
  body_priority,
  recovery_priority,
  daily_activity_priority
)
VALUES
('apple_health', 'Apple Watch%', 30, 25, NULL, 20, 15),
('apple_health', '%iPhone%', NULL, NULL, NULL, NULL, 50),
('apple_health', 'Wahoo TICKR%', 5, NULL, NULL, 5, NULL),
('apple_health', 'Polar H%', 5, NULL, NULL, 5, NULL),
('apple_health', 'Withings%', NULL, NULL, 10, NULL, NULL),
('garmin', 'Edge%', 10, NULL, NULL, NULL, NULL),
('garmin', 'Forerunner%', 15, NULL, NULL, NULL, NULL),
('garmin', 'Fenix%', 12, NULL, NULL, NULL, NULL),
('garmin', 'Venu%', 25, NULL, NULL, NULL, NULL),
('strava', 'Garmin Edge%', 10, NULL, NULL, NULL, NULL),
('strava', 'Wahoo ELEMNT%', 10, NULL, NULL, NULL, NULL),
('strava', 'Fenix%', 12, NULL, NULL, NULL, NULL),
('strava', 'Forerunner%', 15, NULL, NULL, NULL, NULL),
('strava', 'iPhone%', 50, NULL, NULL, NULL, NULL),
('strava', 'Apple Watch%', 30, NULL, NULL, NULL, NULL),
('ride-with-gps', '%iphone%', 50, NULL, NULL, NULL, NULL)
ON CONFLICT (provider_id, source_name_pattern) DO UPDATE SET
  priority = excluded.priority,
  sleep_priority = excluded.sleep_priority,
  body_priority = excluded.body_priority,
  recovery_priority = excluded.recovery_priority,
  daily_activity_priority = excluded.daily_activity_priority;
