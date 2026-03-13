ALTER TABLE fitness.food_entry
  ADD COLUMN confirmed BOOLEAN NOT NULL DEFAULT true;

-- Partial index: most queries filter on confirmed=true, so index only those rows
CREATE INDEX food_entry_confirmed_idx ON fitness.food_entry (confirmed) WHERE confirmed = false;
