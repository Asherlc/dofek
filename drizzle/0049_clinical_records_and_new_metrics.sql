-- New tables for FHIR clinical records + new HealthKit metric columns

-- ============================================================
-- Medication (FHIR MedicationRequest)
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.medication (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT NOT NULL REFERENCES fitness.provider(id),
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES fitness.user_profile(id),
  external_id TEXT,
  name TEXT NOT NULL,
  status TEXT,
  authored_on DATE,
  start_date DATE,
  end_date DATE,
  dosage_text TEXT,
  route TEXT,
  form TEXT,
  rxnorm_code TEXT,
  prescriber_name TEXT,
  reason_text TEXT,
  reason_snomed_code TEXT,
  source_name TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS medication_provider_external_idx
  ON fitness.medication (provider_id, external_id);
CREATE INDEX IF NOT EXISTS medication_user_provider_idx
  ON fitness.medication (user_id, provider_id);

-- ============================================================
-- Condition (FHIR Condition / diagnoses)
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.condition (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT NOT NULL REFERENCES fitness.provider(id),
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES fitness.user_profile(id),
  external_id TEXT,
  name TEXT NOT NULL,
  clinical_status TEXT,
  verification_status TEXT,
  icd10_code TEXT,
  snomed_code TEXT,
  onset_date DATE,
  abatement_date DATE,
  recorded_date DATE,
  source_name TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS condition_provider_external_idx
  ON fitness.condition (provider_id, external_id);
CREATE INDEX IF NOT EXISTS condition_user_provider_idx
  ON fitness.condition (user_id, provider_id);

-- ============================================================
-- Allergy / Intolerance (FHIR AllergyIntolerance)
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.allergy_intolerance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT NOT NULL REFERENCES fitness.provider(id),
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES fitness.user_profile(id),
  external_id TEXT,
  name TEXT NOT NULL,
  type TEXT,
  clinical_status TEXT,
  verification_status TEXT,
  rxnorm_code TEXT,
  onset_date DATE,
  reactions JSONB,
  source_name TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS allergy_intolerance_provider_external_idx
  ON fitness.allergy_intolerance (provider_id, external_id);
CREATE INDEX IF NOT EXISTS allergy_intolerance_user_provider_idx
  ON fitness.allergy_intolerance (user_id, provider_id);

-- ============================================================
-- Medication Dose Event (iOS 26 HKMedicationDoseEvent)
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.medication_dose_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT NOT NULL REFERENCES fitness.provider(id),
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES fitness.user_profile(id),
  external_id TEXT,
  medication_name TEXT NOT NULL,
  medication_concept_id TEXT,
  dose_status TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  source_name TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS medication_dose_event_provider_external_idx
  ON fitness.medication_dose_event (provider_id, external_id);
CREATE INDEX IF NOT EXISTS medication_dose_event_user_provider_idx
  ON fitness.medication_dose_event (user_id, provider_id);
CREATE INDEX IF NOT EXISTS medication_dose_event_recorded_idx
  ON fitness.medication_dose_event (recorded_at);

-- ============================================================
-- New columns on existing tables
-- ============================================================

ALTER TABLE fitness.metric_stream
  ADD COLUMN IF NOT EXISTS electrodermal_activity REAL;

ALTER TABLE fitness.daily_metrics
  ADD COLUMN IF NOT EXISTS push_count BIGINT,
  ADD COLUMN IF NOT EXISTS wheelchair_distance_km REAL,
  ADD COLUMN IF NOT EXISTS uv_exposure REAL;

-- Expand nutrition_daily with full micronutrient columns
-- (previously only had calories, protein_g, carbs_g, fat_g, fiber_g, water_ml)
ALTER TABLE fitness.nutrition_daily
  ADD COLUMN IF NOT EXISTS saturated_fat_g REAL,
  ADD COLUMN IF NOT EXISTS polyunsaturated_fat_g REAL,
  ADD COLUMN IF NOT EXISTS monounsaturated_fat_g REAL,
  ADD COLUMN IF NOT EXISTS trans_fat_g REAL,
  ADD COLUMN IF NOT EXISTS cholesterol_mg REAL,
  ADD COLUMN IF NOT EXISTS sodium_mg REAL,
  ADD COLUMN IF NOT EXISTS potassium_mg REAL,
  ADD COLUMN IF NOT EXISTS sugar_g REAL,
  ADD COLUMN IF NOT EXISTS vitamin_a_mcg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_c_mg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_d_mcg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_e_mg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_k_mcg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b1_mg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b2_mg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b3_mg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b5_mg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b6_mg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b7_mcg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b9_mcg REAL,
  ADD COLUMN IF NOT EXISTS vitamin_b12_mcg REAL,
  ADD COLUMN IF NOT EXISTS calcium_mg REAL,
  ADD COLUMN IF NOT EXISTS iron_mg REAL,
  ADD COLUMN IF NOT EXISTS magnesium_mg REAL,
  ADD COLUMN IF NOT EXISTS zinc_mg REAL,
  ADD COLUMN IF NOT EXISTS selenium_mcg REAL,
  ADD COLUMN IF NOT EXISTS copper_mg REAL,
  ADD COLUMN IF NOT EXISTS manganese_mg REAL,
  ADD COLUMN IF NOT EXISTS chromium_mcg REAL,
  ADD COLUMN IF NOT EXISTS iodine_mcg REAL,
  ADD COLUMN IF NOT EXISTS omega3_mg REAL,
  ADD COLUMN IF NOT EXISTS omega6_mg REAL;
