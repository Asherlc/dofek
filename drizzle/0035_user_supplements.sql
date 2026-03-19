-- Per-user supplement stack definitions (replaces supplements.json)
CREATE TABLE IF NOT EXISTS fitness.supplement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fitness.user_profile(id),
  name TEXT NOT NULL,
  amount REAL,
  unit TEXT,
  form TEXT,
  description TEXT,
  meal fitness.meal,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Macronutrients
  calories INTEGER,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  -- Fat breakdown
  saturated_fat_g REAL,
  polyunsaturated_fat_g REAL,
  monounsaturated_fat_g REAL,
  trans_fat_g REAL,
  -- Other macros
  cholesterol_mg REAL,
  sodium_mg REAL,
  potassium_mg REAL,
  fiber_g REAL,
  sugar_g REAL,
  -- Micronutrients
  vitamin_a_mcg REAL,
  vitamin_c_mg REAL,
  vitamin_d_mcg REAL,
  vitamin_e_mg REAL,
  vitamin_k_mcg REAL,
  vitamin_b1_mg REAL,
  vitamin_b2_mg REAL,
  vitamin_b3_mg REAL,
  vitamin_b5_mg REAL,
  vitamin_b6_mg REAL,
  vitamin_b7_mcg REAL,
  vitamin_b9_mcg REAL,
  vitamin_b12_mcg REAL,
  calcium_mg REAL,
  iron_mg REAL,
  magnesium_mg REAL,
  zinc_mg REAL,
  selenium_mcg REAL,
  copper_mg REAL,
  manganese_mg REAL,
  chromium_mcg REAL,
  iodine_mcg REAL,
  omega3_mg REAL,
  omega6_mg REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplement_user_name_idx ON fitness.supplement (user_id, name);
CREATE INDEX IF NOT EXISTS supplement_user_idx ON fitness.supplement (user_id);
