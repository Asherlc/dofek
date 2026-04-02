-- Convert sleep_stage.stage from text to a Postgres enum.
CREATE TYPE fitness.sleep_stage_name AS ENUM ('deep', 'light', 'rem', 'awake');

-- Step 2: Convert the column from text to enum
ALTER TABLE fitness.sleep_stage 
  ALTER COLUMN stage TYPE fitness.sleep_stage_name 
  USING stage::fitness.sleep_stage_name;
