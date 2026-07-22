-- Tighten integrity invariants on populated tables.
-- These columns are declared with looser constraints in Postgres than in the
-- source-of-truth Drizzle schema, or are protected by a unique index that
-- implicitly forbids NULL once we surface the invariant.

-- strength_set.activity_id is declared NOT NULL in Drizzle
-- (src/db/schema/activity.ts) with an ON DELETE CASCADE FK to activity.id,
-- but the Postgres column was created nullable. All 1020 rows have a value.
ALTER TABLE fitness.strength_set
  ALTER COLUMN activity_id SET NOT NULL;

-- activity.external_id is part of unique index activity_provider_external_idx
-- (user_id, provider_id, external_id) and 100% populated in prod. Without
-- NOT NULL the unique index is permissive (NULL is distinct), but UNIQUENESS
-- here is a real invariant: each (user, provider) row must map 1:1 to a
-- provider-side id. Tighten to enforce that invariant at insert time.
ALTER TABLE fitness.activity
  ALTER COLUMN external_id SET NOT NULL;