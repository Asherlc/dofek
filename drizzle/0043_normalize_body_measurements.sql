-- Normalize body measurements: create reference table + junction table,
-- migrate existing column data, keep old columns for backward compatibility.

-- ============================================================
-- 1. Measurement type reference table
-- ============================================================

CREATE TABLE fitness.measurement_type (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  unit TEXT,
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_integer BOOLEAN NOT NULL DEFAULT false
);

-- ============================================================
-- 2. Seed all known measurement types
-- ============================================================

INSERT INTO fitness.measurement_type (id, display_name, unit, category, sort_order, is_integer) VALUES
  -- Composition
  ('weight',             'Weight',                    'kg',    'composition',    100, false),
  ('body_fat_pct',       'Body Fat',                  '%',     'composition',    101, false),
  ('muscle_mass',        'Muscle Mass',               'kg',    'composition',    102, false),
  ('bone_mass',          'Bone Mass',                 'kg',    'composition',    103, false),
  ('water_pct',          'Water',                     '%',     'composition',    104, false),
  ('bmi',                'BMI',                       'kg/m²', 'composition',    105, false),
  ('lean_body_mass',     'Lean Body Mass',            'kg',    'composition',    106, false),
  ('visceral_fat',       'Visceral Fat Rating',       NULL,    'composition',    107, false),
  ('metabolic_age',      'Metabolic Age',             'years', 'composition',    108, true),
  -- Dimensions
  ('height',             'Height',                    'cm',    'dimension',      200, false),
  ('waist_circumference','Waist Circumference',       'cm',    'dimension',      201, false),
  -- Cardiovascular
  ('systolic_bp',        'Systolic Blood Pressure',   'mmHg',  'cardiovascular', 300, true),
  ('diastolic_bp',       'Diastolic Blood Pressure',  'mmHg',  'cardiovascular', 301, true),
  ('heart_pulse',        'Heart Pulse',               'bpm',   'cardiovascular', 302, true),
  -- Temperature
  ('temperature',        'Body Temperature',          '°C',    'temperature',    400, false);

-- ============================================================
-- 3. Body measurement value junction table
-- ============================================================

CREATE TABLE fitness.body_measurement_value (
  body_measurement_id UUID NOT NULL REFERENCES fitness.body_measurement(id) ON DELETE CASCADE,
  measurement_type_id TEXT NOT NULL REFERENCES fitness.measurement_type(id),
  value REAL NOT NULL,
  PRIMARY KEY (body_measurement_id, measurement_type_id)
);

CREATE INDEX body_measurement_value_entry_idx ON fitness.body_measurement_value(body_measurement_id);
CREATE INDEX body_measurement_value_type_idx ON fitness.body_measurement_value(measurement_type_id);

-- ============================================================
-- 4. Migrate existing column data to junction table
-- ============================================================

INSERT INTO fitness.body_measurement_value (body_measurement_id, measurement_type_id, value)
SELECT id, 'weight', weight_kg FROM fitness.body_measurement WHERE weight_kg IS NOT NULL
UNION ALL
SELECT id, 'body_fat_pct', body_fat_pct FROM fitness.body_measurement WHERE body_fat_pct IS NOT NULL
UNION ALL
SELECT id, 'muscle_mass', muscle_mass_kg FROM fitness.body_measurement WHERE muscle_mass_kg IS NOT NULL
UNION ALL
SELECT id, 'bone_mass', bone_mass_kg FROM fitness.body_measurement WHERE bone_mass_kg IS NOT NULL
UNION ALL
SELECT id, 'water_pct', water_pct FROM fitness.body_measurement WHERE water_pct IS NOT NULL
UNION ALL
SELECT id, 'bmi', bmi FROM fitness.body_measurement WHERE bmi IS NOT NULL
UNION ALL
SELECT id, 'height', height_cm FROM fitness.body_measurement WHERE height_cm IS NOT NULL
UNION ALL
SELECT id, 'waist_circumference', waist_circumference_cm FROM fitness.body_measurement WHERE waist_circumference_cm IS NOT NULL
UNION ALL
SELECT id, 'systolic_bp', systolic_bp FROM fitness.body_measurement WHERE systolic_bp IS NOT NULL
UNION ALL
SELECT id, 'diastolic_bp', diastolic_bp FROM fitness.body_measurement WHERE diastolic_bp IS NOT NULL
UNION ALL
SELECT id, 'heart_pulse', heart_pulse FROM fitness.body_measurement WHERE heart_pulse IS NOT NULL
UNION ALL
SELECT id, 'temperature', temperature_c FROM fitness.body_measurement WHERE temperature_c IS NOT NULL;
