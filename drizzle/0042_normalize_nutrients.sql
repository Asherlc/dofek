-- Normalize micronutrients: create reference table + junction tables,
-- migrate existing column data, keep old columns for backward compatibility.

-- ============================================================
-- 1. Nutrient reference table
-- ============================================================

CREATE TABLE fitness.nutrient (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  category TEXT NOT NULL,
  rda REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  open_food_facts_key TEXT,
  conversion_factor REAL NOT NULL DEFAULT 1.0
);

-- ============================================================
-- 2. Seed all known nutrients
-- ============================================================

INSERT INTO fitness.nutrient (id, display_name, unit, category, rda, sort_order, open_food_facts_key, conversion_factor) VALUES
  -- Fat breakdown
  ('saturated_fat',      'Saturated Fat',                'g',   'fat_breakdown', NULL, 100, 'saturated-fat',      1),
  ('polyunsaturated_fat','Polyunsaturated Fat',           'g',   'fat_breakdown', NULL, 101, 'polyunsaturated-fat', 1),
  ('monounsaturated_fat','Monounsaturated Fat',           'g',   'fat_breakdown', NULL, 102, 'monounsaturated-fat', 1),
  ('trans_fat',          'Trans Fat',                     'g',   'fat_breakdown', NULL, 103, 'trans-fat',           1),
  -- Other macros
  ('cholesterol',        'Cholesterol',                   'mg',  'other_macro',   NULL, 200, 'cholesterol',         1),
  ('sodium',             'Sodium',                        'mg',  'other_macro',   2300, 201, 'sodium',              1000),
  ('potassium',          'Potassium',                     'mg',  'other_macro',   3400, 202, 'potassium',           1),
  ('sugar',              'Sugar',                         'g',   'other_macro',   NULL, 203, 'sugars',              1),
  -- Vitamins
  ('vitamin_a',          'Vitamin A',                     'mcg', 'vitamin',       900,  300, 'vitamin-a',           1),
  ('vitamin_c',          'Vitamin C',                     'mg',  'vitamin',       90,   301, 'vitamin-c',           1),
  ('vitamin_d',          'Vitamin D',                     'mcg', 'vitamin',       15,   302, 'vitamin-d',           1),
  ('vitamin_e',          'Vitamin E',                     'mg',  'vitamin',       15,   303, 'vitamin-e',           1),
  ('vitamin_k',          'Vitamin K',                     'mcg', 'vitamin',       120,  304, 'vitamin-k',           1),
  ('vitamin_b1',         'Vitamin B1 (Thiamin)',          'mg',  'vitamin',       1.2,  305, 'vitamin-b1',          1),
  ('vitamin_b2',         'Vitamin B2 (Riboflavin)',       'mg',  'vitamin',       1.3,  306, 'vitamin-b2',          1),
  ('vitamin_b3',         'Vitamin B3 (Niacin)',           'mg',  'vitamin',       16,   307, 'vitamin-pp',          1),
  ('vitamin_b5',         'Vitamin B5 (Pantothenic Acid)', 'mg',  'vitamin',       5,    308, 'pantothenic-acid',    1),
  ('vitamin_b6',         'Vitamin B6',                    'mg',  'vitamin',       1.3,  309, 'vitamin-b6',          1),
  ('vitamin_b7',         'Vitamin B7 (Biotin)',           'mcg', 'vitamin',       30,   310, 'biotin',              1),
  ('vitamin_b9',         'Vitamin B9 (Folate)',           'mcg', 'vitamin',       400,  311, 'vitamin-b9',          1),
  ('vitamin_b12',        'Vitamin B12',                   'mcg', 'vitamin',       2.4,  312, 'vitamin-b12',         1),
  -- Minerals
  ('calcium',            'Calcium',                       'mg',  'mineral',       1000, 400, 'calcium',             1),
  ('iron',               'Iron',                          'mg',  'mineral',       8,    401, 'iron',                1),
  ('magnesium',          'Magnesium',                     'mg',  'mineral',       420,  402, 'magnesium',           1),
  ('zinc',               'Zinc',                          'mg',  'mineral',       11,   403, 'zinc',                1),
  ('selenium',           'Selenium',                      'mcg', 'mineral',       55,   404, 'selenium',            1),
  ('copper',             'Copper',                        'mg',  'mineral',       0.9,  405, 'copper',              1),
  ('manganese',          'Manganese',                     'mg',  'mineral',       2.3,  406, 'manganese',           1),
  ('chromium',           'Chromium',                      'mcg', 'mineral',       35,   407, 'chromium',            1),
  ('iodine',             'Iodine',                        'mcg', 'mineral',       150,  408, 'iodine',              1),
  ('phosphorus',         'Phosphorus',                    'mg',  'mineral',       700,  409, 'phosphorus',          1),
  ('molybdenum',         'Molybdenum',                    'mcg', 'mineral',       45,   410, 'molybdenum',          1),
  ('chloride',           'Chloride',                      'mg',  'mineral',       2300, 411, 'chloride',            1),
  ('fluoride',           'Fluoride',                      'mg',  'mineral',       4,    412, 'fluoride',            1),
  ('choline',            'Choline',                       'mg',  'mineral',       550,  413, 'choline',             1),
  -- Fatty acids
  ('omega_3',            'Omega-3',                       'mg',  'fatty_acid',    NULL, 500, 'omega-3-fat',         1000),
  ('omega_6',            'Omega-6',                       'mg',  'fatty_acid',    NULL, 501, 'omega-6-fat',         1000);

-- ============================================================
-- 3. Food entry nutrient junction table
-- ============================================================

CREATE TABLE fitness.food_entry_nutrient (
  food_entry_id UUID NOT NULL REFERENCES fitness.food_entry(id) ON DELETE CASCADE,
  nutrient_id TEXT NOT NULL REFERENCES fitness.nutrient(id),
  amount REAL NOT NULL,
  PRIMARY KEY (food_entry_id, nutrient_id)
);

CREATE INDEX food_entry_nutrient_entry_idx ON fitness.food_entry_nutrient(food_entry_id);

-- ============================================================
-- 4. Supplement nutrient junction table
-- ============================================================

CREATE TABLE fitness.supplement_nutrient (
  supplement_id UUID NOT NULL REFERENCES fitness.supplement(id) ON DELETE CASCADE,
  nutrient_id TEXT NOT NULL REFERENCES fitness.nutrient(id),
  amount REAL NOT NULL,
  PRIMARY KEY (supplement_id, nutrient_id)
);

CREATE INDEX supplement_nutrient_supplement_idx ON fitness.supplement_nutrient(supplement_id);

-- ============================================================
-- 5. Migrate existing food_entry nutrient data to junction table
-- (Nutrient columns now live in nutrition_data, linked via food_entry.nutrition_data_id)
-- ============================================================

INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
SELECT fe.id, 'saturated_fat', nd.saturated_fat_g FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.saturated_fat_g IS NOT NULL
UNION ALL
SELECT fe.id, 'polyunsaturated_fat', nd.polyunsaturated_fat_g FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.polyunsaturated_fat_g IS NOT NULL
UNION ALL
SELECT fe.id, 'monounsaturated_fat', nd.monounsaturated_fat_g FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.monounsaturated_fat_g IS NOT NULL
UNION ALL
SELECT fe.id, 'trans_fat', nd.trans_fat_g FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.trans_fat_g IS NOT NULL
UNION ALL
SELECT fe.id, 'cholesterol', nd.cholesterol_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.cholesterol_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'sodium', nd.sodium_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.sodium_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'potassium', nd.potassium_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.potassium_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'sugar', nd.sugar_g FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.sugar_g IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_a', nd.vitamin_a_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_a_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_c', nd.vitamin_c_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_c_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_d', nd.vitamin_d_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_d_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_e', nd.vitamin_e_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_e_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_k', nd.vitamin_k_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_k_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b1', nd.vitamin_b1_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b1_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b2', nd.vitamin_b2_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b2_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b3', nd.vitamin_b3_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b3_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b5', nd.vitamin_b5_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b5_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b6', nd.vitamin_b6_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b6_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b7', nd.vitamin_b7_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b7_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b9', nd.vitamin_b9_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b9_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'vitamin_b12', nd.vitamin_b12_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.vitamin_b12_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'calcium', nd.calcium_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.calcium_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'iron', nd.iron_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.iron_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'magnesium', nd.magnesium_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.magnesium_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'zinc', nd.zinc_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.zinc_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'selenium', nd.selenium_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.selenium_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'copper', nd.copper_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.copper_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'manganese', nd.manganese_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.manganese_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'chromium', nd.chromium_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.chromium_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'iodine', nd.iodine_mcg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.iodine_mcg IS NOT NULL
UNION ALL
SELECT fe.id, 'omega_3', nd.omega3_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.omega3_mg IS NOT NULL
UNION ALL
SELECT fe.id, 'omega_6', nd.omega6_mg FROM fitness.food_entry fe JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id WHERE nd.omega6_mg IS NOT NULL;

-- ============================================================
-- 6. Migrate existing supplement nutrient data to junction table
-- (Nutrient columns now live in nutrition_data, linked via supplement.nutrition_data_id)
-- ============================================================

INSERT INTO fitness.supplement_nutrient (supplement_id, nutrient_id, amount)
SELECT s.id, 'saturated_fat', nd.saturated_fat_g FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.saturated_fat_g IS NOT NULL
UNION ALL
SELECT s.id, 'polyunsaturated_fat', nd.polyunsaturated_fat_g FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.polyunsaturated_fat_g IS NOT NULL
UNION ALL
SELECT s.id, 'monounsaturated_fat', nd.monounsaturated_fat_g FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.monounsaturated_fat_g IS NOT NULL
UNION ALL
SELECT s.id, 'trans_fat', nd.trans_fat_g FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.trans_fat_g IS NOT NULL
UNION ALL
SELECT s.id, 'cholesterol', nd.cholesterol_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.cholesterol_mg IS NOT NULL
UNION ALL
SELECT s.id, 'sodium', nd.sodium_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.sodium_mg IS NOT NULL
UNION ALL
SELECT s.id, 'potassium', nd.potassium_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.potassium_mg IS NOT NULL
UNION ALL
SELECT s.id, 'sugar', nd.sugar_g FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.sugar_g IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_a', nd.vitamin_a_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_a_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_c', nd.vitamin_c_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_c_mg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_d', nd.vitamin_d_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_d_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_e', nd.vitamin_e_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_e_mg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_k', nd.vitamin_k_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_k_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b1', nd.vitamin_b1_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b1_mg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b2', nd.vitamin_b2_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b2_mg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b3', nd.vitamin_b3_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b3_mg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b5', nd.vitamin_b5_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b5_mg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b6', nd.vitamin_b6_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b6_mg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b7', nd.vitamin_b7_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b7_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b9', nd.vitamin_b9_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b9_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'vitamin_b12', nd.vitamin_b12_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.vitamin_b12_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'calcium', nd.calcium_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.calcium_mg IS NOT NULL
UNION ALL
SELECT s.id, 'iron', nd.iron_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.iron_mg IS NOT NULL
UNION ALL
SELECT s.id, 'magnesium', nd.magnesium_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.magnesium_mg IS NOT NULL
UNION ALL
SELECT s.id, 'zinc', nd.zinc_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.zinc_mg IS NOT NULL
UNION ALL
SELECT s.id, 'selenium', nd.selenium_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.selenium_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'copper', nd.copper_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.copper_mg IS NOT NULL
UNION ALL
SELECT s.id, 'manganese', nd.manganese_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.manganese_mg IS NOT NULL
UNION ALL
SELECT s.id, 'chromium', nd.chromium_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.chromium_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'iodine', nd.iodine_mcg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.iodine_mcg IS NOT NULL
UNION ALL
SELECT s.id, 'omega_3', nd.omega3_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.omega3_mg IS NOT NULL
UNION ALL
SELECT s.id, 'omega_6', nd.omega6_mg FROM fitness.supplement s JOIN fitness.nutrition_data nd ON s.nutrition_data_id = nd.id WHERE nd.omega6_mg IS NOT NULL;
