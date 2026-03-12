ALTER TABLE fitness.food_entry ADD COLUMN logged_at TIMESTAMPTZ;
ALTER TABLE fitness.food_entry ADD COLUMN barcode TEXT;
ALTER TABLE fitness.food_entry ADD COLUMN serving_unit TEXT;
ALTER TABLE fitness.food_entry ADD COLUMN serving_weight_grams REAL;
