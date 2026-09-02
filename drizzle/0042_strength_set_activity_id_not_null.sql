-- strength_set.activity_id is declared NOT NULL in Drizzle (src/db/schema/activity.ts)
-- with an ON DELETE CASCADE FK to activity.id, but the Postgres column was created
-- nullable before .notNull() was added to the schema. All 1020 rows have a value,
-- so tighten the column to match the source of truth.
ALTER TABLE fitness.strength_set
  ALTER COLUMN activity_id SET NOT NULL;