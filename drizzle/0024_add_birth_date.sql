-- Add birth_date column to user_profile for healthspan/biological age calculation
ALTER TABLE fitness.user_profile
  ADD COLUMN IF NOT EXISTS birth_date DATE;
