INSERT INTO fitness.daily_metric_type
  (id, display_name, unit, category, priority_category, sort_order, is_integer)
VALUES
  ('weight', 'Weight', 'kg', 'body', 'body', 0, false),
  ('resting_heart_rate', 'Resting heart rate', 'bpm', 'heart', 'recovery', 0, true),
  ('sleep_duration_reported', 'Sleep duration (provider-reported)', 'sec', 'sleep', 'sleep', 0, true)
ON CONFLICT (id) DO NOTHING;
