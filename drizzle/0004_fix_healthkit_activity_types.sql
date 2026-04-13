-- Fix misclassified HealthKit activities caused by wrong workoutActivityTypeMap.
--
-- The mobile HealthKit sync had an off-by-one mapping bug: it skipped deprecated
-- HKWorkoutActivityType rawValues (danceInspiredTraining=15, mixedMetabolicCardioTraining=30),
-- shifting all subsequent keys. For example, hiking (rawValue 24) was stored as "hockey".
--
-- The raw JSON column preserves the original workoutType string, so we can correct
-- activity_type for all affected apple_health activities.
--
-- Only rawValues where the old mapping produced a VALID (but wrong) DB enum value
-- need correction. RawValues that mapped to camelCase strings (e.g. "equestrianSports")
-- would have failed the Postgres enum check and never been stored.

UPDATE fitness.activity
SET activity_type = (CASE (raw->>'workoutType')
  WHEN '15' THEN 'dance'              -- was stored as 'elliptical' (danceInspiredTraining)
  WHEN '17' THEN 'equestrian'         -- was stored as 'fencing'
  WHEN '18' THEN 'fencing'            -- was stored as 'fishing'
  WHEN '20' THEN 'functional_strength' -- was stored as 'golf'
  WHEN '21' THEN 'golf'               -- was stored as 'gymnastics'
  WHEN '22' THEN 'gymnastics'         -- was stored as 'handball'
  WHEN '23' THEN 'handball'           -- was stored as 'hiking'
  WHEN '24' THEN 'hiking'             -- was stored as 'hockey'
  WHEN '25' THEN 'hockey'             -- was stored as 'hunting'
  WHEN '26' THEN 'hunting'            -- was stored as 'lacrosse'
  WHEN '30' THEN 'mixed_metabolic_cardio' -- was stored as 'play'
  WHEN '32' THEN 'play'               -- was stored as 'racquetball'
  WHEN '33' THEN 'preparation_and_recovery' -- was stored as 'rowing'
  WHEN '34' THEN 'racquetball'         -- was stored as 'rugby'
  WHEN '35' THEN 'rowing'             -- was stored as 'running'
  WHEN '36' THEN 'rugby'              -- was stored as 'sailing'
  WHEN '39' THEN 'skating'            -- was stored as 'soccer'
  WHEN '40' THEN 'snow_sports'        -- was stored as 'softball'
  WHEN '41' THEN 'soccer'             -- was stored as 'squash'
  WHEN '44' THEN 'stair_climbing'     -- was stored as 'swimming'
  WHEN '47' THEN 'table_tennis'       -- was stored as 'tennis'
  WHEN '50' THEN 'strength_training'  -- was stored as 'volleyball'
  WHEN '51' THEN 'volleyball'         -- was stored as 'walking'
END)::fitness.activity_type
WHERE provider_id = 'apple_health'
  AND raw->>'workoutType' IS NOT NULL
  AND (raw->>'workoutType') IN (
    '15','17','18','20','21','22','23','24','25','26',
    '30','32','33','34','35','36','39','40','41','44',
    '47','50','51'
  )
  -- Only update rows that still hold the known wrong activity_type from the
  -- old mapping. This avoids overwriting any manually corrected values and
  -- narrows the scan to rows that actually need fixing.
  AND activity_type IN (
    'elliptical',   -- was wrong for rawValue 15 (danceInspiredTraining)
    'fencing',      -- was wrong for rawValues 17, 18
    'fishing',
    'golf',         -- was wrong for rawValues 20, 21
    'gymnastics',
    'handball',     -- was wrong for rawValues 22, 23
    'hiking',
    'hockey',       -- was wrong for rawValues 24, 25
    'hunting',
    'lacrosse',     -- was wrong for rawValue 26
    'play',         -- was wrong for rawValues 30, 32
    'racquetball',
    'rowing',       -- was wrong for rawValues 33, 35
    'rugby',
    'running',
    'sailing',      -- was wrong for rawValue 36
    'soccer',       -- was wrong for rawValues 39, 41
    'softball',
    'squash',
    'swimming',     -- was wrong for rawValue 44
    'tennis',       -- was wrong for rawValue 47
    'volleyball',   -- was wrong for rawValues 50, 51
    'walking'
  );
