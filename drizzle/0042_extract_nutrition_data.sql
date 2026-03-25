-- Extract shared nutrient columns from food_entry and supplement into nutrition_data table.
-- Both tables currently have 39 identical nutrient columns. This migration:
--   1. Creates nutrition_data table
--   2. Migrates existing nutrient values from food_entry → nutrition_data
--   3. Migrates existing nutrient values from supplement → nutrition_data
--   4. Drops old nutrient columns from both tables
--   5. Creates views that join the tables back together for query convenience

-- ============================================================
-- Step 1: Create nutrition_data table
-- ============================================================

CREATE TABLE fitness.nutrition_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  -- Vitamins
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
  -- Minerals
  calcium_mg REAL,
  iron_mg REAL,
  magnesium_mg REAL,
  zinc_mg REAL,
  selenium_mcg REAL,
  copper_mg REAL,
  manganese_mg REAL,
  chromium_mcg REAL,
  iodine_mcg REAL,
  -- Fatty acids
  omega3_mg REAL,
  omega6_mg REAL,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Step 2: Migrate food_entry nutrient data
-- ============================================================

-- Add FK column first
ALTER TABLE fitness.food_entry ADD COLUMN nutrition_data_id UUID REFERENCES fitness.nutrition_data(id);

-- Insert nutrition data from food_entry rows (reuse food_entry.id as nutrition_data.id for correlation)
INSERT INTO fitness.nutrition_data (
  id, calories, protein_g, carbs_g, fat_g,
  saturated_fat_g, polyunsaturated_fat_g, monounsaturated_fat_g, trans_fat_g,
  cholesterol_mg, sodium_mg, potassium_mg, fiber_g, sugar_g,
  vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg, vitamin_e_mg, vitamin_k_mcg,
  vitamin_b1_mg, vitamin_b2_mg, vitamin_b3_mg, vitamin_b5_mg, vitamin_b6_mg,
  vitamin_b7_mcg, vitamin_b9_mcg, vitamin_b12_mcg,
  calcium_mg, iron_mg, magnesium_mg, zinc_mg, selenium_mcg,
  copper_mg, manganese_mg, chromium_mcg, iodine_mcg,
  omega3_mg, omega6_mg, created_at
)
SELECT
  id, calories, protein_g, carbs_g, fat_g,
  saturated_fat_g, polyunsaturated_fat_g, monounsaturated_fat_g, trans_fat_g,
  cholesterol_mg, sodium_mg, potassium_mg, fiber_g, sugar_g,
  vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg, vitamin_e_mg, vitamin_k_mcg,
  vitamin_b1_mg, vitamin_b2_mg, vitamin_b3_mg, vitamin_b5_mg, vitamin_b6_mg,
  vitamin_b7_mcg, vitamin_b9_mcg, vitamin_b12_mcg,
  calcium_mg, iron_mg, magnesium_mg, zinc_mg, selenium_mcg,
  copper_mg, manganese_mg, chromium_mcg, iodine_mcg,
  omega3_mg, omega6_mg, created_at
FROM fitness.food_entry;

-- Link food_entry rows to their nutrition_data (same ID was used)
UPDATE fitness.food_entry SET nutrition_data_id = id;

-- ============================================================
-- Step 3: Migrate supplement nutrient data
-- ============================================================

ALTER TABLE fitness.supplement ADD COLUMN nutrition_data_id UUID REFERENCES fitness.nutrition_data(id);

-- Supplements use separate UUIDs to avoid collision with food_entry IDs
INSERT INTO fitness.nutrition_data (
  id, calories, protein_g, carbs_g, fat_g,
  saturated_fat_g, polyunsaturated_fat_g, monounsaturated_fat_g, trans_fat_g,
  cholesterol_mg, sodium_mg, potassium_mg, fiber_g, sugar_g,
  vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg, vitamin_e_mg, vitamin_k_mcg,
  vitamin_b1_mg, vitamin_b2_mg, vitamin_b3_mg, vitamin_b5_mg, vitamin_b6_mg,
  vitamin_b7_mcg, vitamin_b9_mcg, vitamin_b12_mcg,
  calcium_mg, iron_mg, magnesium_mg, zinc_mg, selenium_mcg,
  copper_mg, manganese_mg, chromium_mcg, iodine_mcg,
  omega3_mg, omega6_mg, created_at
)
SELECT
  id, calories, protein_g, carbs_g, fat_g,
  saturated_fat_g, polyunsaturated_fat_g, monounsaturated_fat_g, trans_fat_g,
  cholesterol_mg, sodium_mg, potassium_mg, fiber_g, sugar_g,
  vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg, vitamin_e_mg, vitamin_k_mcg,
  vitamin_b1_mg, vitamin_b2_mg, vitamin_b3_mg, vitamin_b5_mg, vitamin_b6_mg,
  vitamin_b7_mcg, vitamin_b9_mcg, vitamin_b12_mcg,
  calcium_mg, iron_mg, magnesium_mg, zinc_mg, selenium_mcg,
  copper_mg, manganese_mg, chromium_mcg, iodine_mcg,
  omega3_mg, omega6_mg, created_at
FROM fitness.supplement;

UPDATE fitness.supplement SET nutrition_data_id = id;

-- ============================================================
-- Step 4: Drop old nutrient columns from food_entry
-- ============================================================

ALTER TABLE fitness.food_entry
  DROP COLUMN calories,
  DROP COLUMN protein_g,
  DROP COLUMN carbs_g,
  DROP COLUMN fat_g,
  DROP COLUMN saturated_fat_g,
  DROP COLUMN polyunsaturated_fat_g,
  DROP COLUMN monounsaturated_fat_g,
  DROP COLUMN trans_fat_g,
  DROP COLUMN cholesterol_mg,
  DROP COLUMN sodium_mg,
  DROP COLUMN potassium_mg,
  DROP COLUMN fiber_g,
  DROP COLUMN sugar_g,
  DROP COLUMN vitamin_a_mcg,
  DROP COLUMN vitamin_c_mg,
  DROP COLUMN vitamin_d_mcg,
  DROP COLUMN vitamin_e_mg,
  DROP COLUMN vitamin_k_mcg,
  DROP COLUMN vitamin_b1_mg,
  DROP COLUMN vitamin_b2_mg,
  DROP COLUMN vitamin_b3_mg,
  DROP COLUMN vitamin_b5_mg,
  DROP COLUMN vitamin_b6_mg,
  DROP COLUMN vitamin_b7_mcg,
  DROP COLUMN vitamin_b9_mcg,
  DROP COLUMN vitamin_b12_mcg,
  DROP COLUMN calcium_mg,
  DROP COLUMN iron_mg,
  DROP COLUMN magnesium_mg,
  DROP COLUMN zinc_mg,
  DROP COLUMN selenium_mcg,
  DROP COLUMN copper_mg,
  DROP COLUMN manganese_mg,
  DROP COLUMN chromium_mcg,
  DROP COLUMN iodine_mcg,
  DROP COLUMN omega3_mg,
  DROP COLUMN omega6_mg;

-- ============================================================
-- Step 5: Drop old nutrient columns from supplement
-- ============================================================

ALTER TABLE fitness.supplement
  DROP COLUMN calories,
  DROP COLUMN protein_g,
  DROP COLUMN carbs_g,
  DROP COLUMN fat_g,
  DROP COLUMN saturated_fat_g,
  DROP COLUMN polyunsaturated_fat_g,
  DROP COLUMN monounsaturated_fat_g,
  DROP COLUMN trans_fat_g,
  DROP COLUMN cholesterol_mg,
  DROP COLUMN sodium_mg,
  DROP COLUMN potassium_mg,
  DROP COLUMN fiber_g,
  DROP COLUMN sugar_g,
  DROP COLUMN vitamin_a_mcg,
  DROP COLUMN vitamin_c_mg,
  DROP COLUMN vitamin_d_mcg,
  DROP COLUMN vitamin_e_mg,
  DROP COLUMN vitamin_k_mcg,
  DROP COLUMN vitamin_b1_mg,
  DROP COLUMN vitamin_b2_mg,
  DROP COLUMN vitamin_b3_mg,
  DROP COLUMN vitamin_b5_mg,
  DROP COLUMN vitamin_b6_mg,
  DROP COLUMN vitamin_b7_mcg,
  DROP COLUMN vitamin_b9_mcg,
  DROP COLUMN vitamin_b12_mcg,
  DROP COLUMN calcium_mg,
  DROP COLUMN iron_mg,
  DROP COLUMN magnesium_mg,
  DROP COLUMN zinc_mg,
  DROP COLUMN selenium_mcg,
  DROP COLUMN copper_mg,
  DROP COLUMN manganese_mg,
  DROP COLUMN chromium_mcg,
  DROP COLUMN iodine_mcg,
  DROP COLUMN omega3_mg,
  DROP COLUMN omega6_mg;

-- ============================================================
-- Step 6: Create convenience views that flatten the JOIN
-- ============================================================

-- View that looks like the old food_entry table (with nutrient columns inline)
CREATE OR REPLACE VIEW fitness.v_food_entry_with_nutrition AS
SELECT
  fe.id,
  fe.provider_id,
  fe.user_id,
  fe.external_id,
  fe.date,
  fe.meal,
  fe.food_name,
  fe.food_description,
  fe.category,
  fe.provider_food_id,
  fe.provider_serving_id,
  fe.number_of_units,
  fe.logged_at,
  fe.barcode,
  fe.serving_unit,
  fe.serving_weight_grams,
  fe.nutrition_data_id,
  -- Nutrient columns from nutrition_data
  nd.calories,
  nd.protein_g,
  nd.carbs_g,
  nd.fat_g,
  nd.saturated_fat_g,
  nd.polyunsaturated_fat_g,
  nd.monounsaturated_fat_g,
  nd.trans_fat_g,
  nd.cholesterol_mg,
  nd.sodium_mg,
  nd.potassium_mg,
  nd.fiber_g,
  nd.sugar_g,
  nd.vitamin_a_mcg,
  nd.vitamin_c_mg,
  nd.vitamin_d_mcg,
  nd.vitamin_e_mg,
  nd.vitamin_k_mcg,
  nd.vitamin_b1_mg,
  nd.vitamin_b2_mg,
  nd.vitamin_b3_mg,
  nd.vitamin_b5_mg,
  nd.vitamin_b6_mg,
  nd.vitamin_b7_mcg,
  nd.vitamin_b9_mcg,
  nd.vitamin_b12_mcg,
  nd.calcium_mg,
  nd.iron_mg,
  nd.magnesium_mg,
  nd.zinc_mg,
  nd.selenium_mcg,
  nd.copper_mg,
  nd.manganese_mg,
  nd.chromium_mcg,
  nd.iodine_mcg,
  nd.omega3_mg,
  nd.omega6_mg,
  fe.raw,
  fe.confirmed,
  fe.created_at
FROM fitness.food_entry fe
LEFT JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id;

-- View that looks like the old supplement table (with nutrient columns inline)
CREATE OR REPLACE VIEW fitness.v_supplement_with_nutrition AS
SELECT
  s.id,
  s.user_id,
  s.name,
  s.amount,
  s.unit,
  s.form,
  s.description,
  s.meal,
  s.sort_order,
  s.nutrition_data_id,
  -- Nutrient columns from nutrition_data
  nd.calories,
  nd.protein_g,
  nd.carbs_g,
  nd.fat_g,
  nd.saturated_fat_g,
  nd.polyunsaturated_fat_g,
  nd.monounsaturated_fat_g,
  nd.trans_fat_g,
  nd.cholesterol_mg,
  nd.sodium_mg,
  nd.potassium_mg,
  nd.fiber_g,
  nd.sugar_g,
  nd.vitamin_a_mcg,
  nd.vitamin_c_mg,
  nd.vitamin_d_mcg,
  nd.vitamin_e_mg,
  nd.vitamin_k_mcg,
  nd.vitamin_b1_mg,
  nd.vitamin_b2_mg,
  nd.vitamin_b3_mg,
  nd.vitamin_b5_mg,
  nd.vitamin_b6_mg,
  nd.vitamin_b7_mcg,
  nd.vitamin_b9_mcg,
  nd.vitamin_b12_mcg,
  nd.calcium_mg,
  nd.iron_mg,
  nd.magnesium_mg,
  nd.zinc_mg,
  nd.selenium_mcg,
  nd.copper_mg,
  nd.manganese_mg,
  nd.chromium_mcg,
  nd.iodine_mcg,
  nd.omega3_mg,
  nd.omega6_mg,
  s.created_at,
  s.updated_at
FROM fitness.supplement s
LEFT JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id;

-- Index on nutrition_data_id for fast JOINs
CREATE INDEX food_entry_nutrition_data_idx ON fitness.food_entry(nutrition_data_id);
CREATE INDEX supplement_nutrition_data_idx ON fitness.supplement(nutrition_data_id);
