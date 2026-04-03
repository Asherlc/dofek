-- Convert sleep_stage.stage from text to a Postgres enum.
CREATE TYPE fitness.sleep_stage_name AS ENUM ('deep', 'light', 'rem', 'awake');

-- Step 2: Convert the column from text to enum (requires table rewrite; acceptable for this small table)
ALTER TABLE fitness.sleep_stage
  -- squawk-ignore changing-column-type
  ALTER COLUMN stage TYPE fitness.sleep_stage_name
  USING stage::fitness.sleep_stage_name;
