-- Tighten integrity invariants on populated tables.
-- These columns are declared with looser constraints in Postgres than in the
-- source-of-truth Drizzle schema, or are protected by a unique index that
-- implicitly forbids NULL once we surface the invariant.

-- activity.external_id is part of unique index activity_provider_external_idx
-- (user_id, provider_id, external_id) and 100% populated in prod. Without
-- NOT NULL the unique index is permissive (NULL is distinct), but UNIQUENESS
-- here is a real invariant: each (user, provider) row must map 1:1 to a
-- provider-side id. Tighten to enforce that invariant at insert time.
ALTER TABLE fitness.activity
ADD CONSTRAINT activity_external_id_not_null_chk
CHECK (external_id IS NOT NULL) NOT VALID;

ALTER TABLE fitness.activity
VALIDATE CONSTRAINT activity_external_id_not_null_chk;

ALTER TABLE fitness.activity
ALTER COLUMN external_id SET NOT NULL;
