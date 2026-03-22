-- Normalize daily metrics: create reference table + junction table,
-- migrate existing column data, keep old columns for backward compatibility.

-- ============================================================
-- 1. Daily metric type reference table
-- ============================================================

CREATE TABLE fitness.daily_metric_type (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  unit TEXT,
  category TEXT NOT NULL,
  priority_category TEXT NOT NULL DEFAULT 'activity',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_integer BOOLEAN NOT NULL DEFAULT false
);

-- ============================================================
-- 2. Seed all known daily metric types
-- ============================================================

INSERT INTO fitness.daily_metric_type (id, display_name, unit, category, priority_category, sort_order, is_integer) VALUES
  -- Recovery
  ('resting_hr',                  'Resting Heart Rate',            'bpm',         'recovery', 'recovery', 100, true),
  ('hrv',                         'Heart Rate Variability',        'ms',          'recovery', 'recovery', 101, false),
  ('vo2max',                      'VO2max',                        'ml/kg/min',   'recovery', 'recovery', 102, false),
  ('spo2_avg',                    'Blood Oxygen (SpO2)',           '%',           'recovery', 'recovery', 103, false),
  ('respiratory_rate_avg',        'Respiratory Rate',              'breaths/min', 'recovery', 'recovery', 104, false),
  ('skin_temp_c',                 'Skin Temperature',              '°C',          'recovery', 'recovery', 105, false),
  -- Activity
  ('steps',                       'Steps',                         'steps',       'activity', 'activity', 200, true),
  ('active_energy_kcal',          'Active Calories',               'kcal',        'activity', 'activity', 201, false),
  ('basal_energy_kcal',           'Basal Calories',                'kcal',        'activity', 'activity', 202, false),
  ('distance_km',                 'Walking + Running Distance',    'km',          'activity', 'activity', 203, false),
  ('cycling_distance_km',         'Cycling Distance',              'km',          'activity', 'activity', 204, false),
  ('flights_climbed',             'Flights Climbed',               'flights',     'activity', 'activity', 205, true),
  ('exercise_minutes',            'Exercise Minutes',              'min',         'activity', 'activity', 206, true),
  ('mindful_minutes',             'Mindful Minutes',               'min',         'activity', 'activity', 207, true),
  ('stand_hours',                 'Stand Hours',                   'hours',       'activity', 'activity', 208, true),
  -- Gait
  ('walking_speed',               'Walking Speed',                 'm/s',         'gait',    'activity', 300, false),
  ('walking_step_length',         'Walking Step Length',            'cm',          'gait',    'activity', 301, false),
  ('walking_double_support_pct',  'Walking Double Support',        '%',           'gait',    'activity', 302, false),
  ('walking_asymmetry_pct',       'Walking Asymmetry',             '%',           'gait',    'activity', 303, false),
  ('walking_steadiness',          'Walking Steadiness',            NULL,          'gait',    'activity', 304, false),
  -- Audio
  ('environmental_audio_exposure','Environmental Audio Exposure',  'dBASPL',      'audio',   'activity', 400, false),
  ('headphone_audio_exposure',    'Headphone Audio Exposure',      'dBASPL',      'audio',   'activity', 401, false),
  -- Stress
  ('stress_high_minutes',         'High Stress Minutes',           'min',         'stress',  'recovery', 500, true),
  ('recovery_high_minutes',       'High Recovery Minutes',         'min',         'stress',  'recovery', 501, true);

-- ============================================================
-- 3. Daily metric value junction table
-- ============================================================

CREATE TABLE fitness.daily_metric_value (
  daily_metrics_id UUID NOT NULL REFERENCES fitness.daily_metrics(id) ON DELETE CASCADE,
  metric_type_id TEXT NOT NULL REFERENCES fitness.daily_metric_type(id),
  value REAL NOT NULL,
  PRIMARY KEY (daily_metrics_id, metric_type_id)
);

CREATE INDEX daily_metric_value_entry_idx ON fitness.daily_metric_value(daily_metrics_id);
CREATE INDEX daily_metric_value_type_idx ON fitness.daily_metric_value(metric_type_id);

-- ============================================================
-- 4. Migrate existing column data to junction table
-- ============================================================

INSERT INTO fitness.daily_metric_value (daily_metrics_id, metric_type_id, value)
SELECT id, 'resting_hr', resting_hr FROM fitness.daily_metrics WHERE resting_hr IS NOT NULL
UNION ALL
SELECT id, 'hrv', hrv FROM fitness.daily_metrics WHERE hrv IS NOT NULL
UNION ALL
SELECT id, 'vo2max', vo2max FROM fitness.daily_metrics WHERE vo2max IS NOT NULL
UNION ALL
SELECT id, 'spo2_avg', spo2_avg FROM fitness.daily_metrics WHERE spo2_avg IS NOT NULL
UNION ALL
SELECT id, 'respiratory_rate_avg', respiratory_rate_avg FROM fitness.daily_metrics WHERE respiratory_rate_avg IS NOT NULL
UNION ALL
SELECT id, 'skin_temp_c', skin_temp_c FROM fitness.daily_metrics WHERE skin_temp_c IS NOT NULL
UNION ALL
SELECT id, 'steps', steps FROM fitness.daily_metrics WHERE steps IS NOT NULL
UNION ALL
SELECT id, 'active_energy_kcal', active_energy_kcal FROM fitness.daily_metrics WHERE active_energy_kcal IS NOT NULL
UNION ALL
SELECT id, 'basal_energy_kcal', basal_energy_kcal FROM fitness.daily_metrics WHERE basal_energy_kcal IS NOT NULL
UNION ALL
SELECT id, 'distance_km', distance_km FROM fitness.daily_metrics WHERE distance_km IS NOT NULL
UNION ALL
SELECT id, 'cycling_distance_km', cycling_distance_km FROM fitness.daily_metrics WHERE cycling_distance_km IS NOT NULL
UNION ALL
SELECT id, 'flights_climbed', flights_climbed FROM fitness.daily_metrics WHERE flights_climbed IS NOT NULL
UNION ALL
SELECT id, 'exercise_minutes', exercise_minutes FROM fitness.daily_metrics WHERE exercise_minutes IS NOT NULL
UNION ALL
SELECT id, 'stand_hours', stand_hours FROM fitness.daily_metrics WHERE stand_hours IS NOT NULL
UNION ALL
SELECT id, 'walking_speed', walking_speed FROM fitness.daily_metrics WHERE walking_speed IS NOT NULL
UNION ALL
SELECT id, 'walking_step_length', walking_step_length FROM fitness.daily_metrics WHERE walking_step_length IS NOT NULL
UNION ALL
SELECT id, 'walking_double_support_pct', walking_double_support_pct FROM fitness.daily_metrics WHERE walking_double_support_pct IS NOT NULL
UNION ALL
SELECT id, 'walking_asymmetry_pct', walking_asymmetry_pct FROM fitness.daily_metrics WHERE walking_asymmetry_pct IS NOT NULL
UNION ALL
SELECT id, 'walking_steadiness', walking_steadiness FROM fitness.daily_metrics WHERE walking_steadiness IS NOT NULL
UNION ALL
SELECT id, 'stress_high_minutes', stress_high_minutes FROM fitness.daily_metrics WHERE stress_high_minutes IS NOT NULL
UNION ALL
SELECT id, 'recovery_high_minutes', recovery_high_minutes FROM fitness.daily_metrics WHERE recovery_high_minutes IS NOT NULL;
