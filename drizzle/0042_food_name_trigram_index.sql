-- Enable pg_trgm extension for fast ILIKE pattern matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on food_name for fast ILIKE '%query%' searches
CREATE INDEX IF NOT EXISTS food_entry_food_name_trgm_idx
  ON fitness.food_entry
  USING gin (food_name gin_trgm_ops);
