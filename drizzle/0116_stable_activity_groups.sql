CREATE TABLE fitness.activity_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  anchor_activity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX activity_group_user_id_idx ON fitness.activity_group (user_id, id);
--> statement-breakpoint
CREATE TABLE fitness.activity_group_alias (
  alias_id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_group_alias_user_group_fk FOREIGN KEY (user_id, group_id)
  REFERENCES fitness.activity_group (user_id, id),
  CONSTRAINT activity_group_alias_not_self CHECK (alias_id <> group_id),
  CONSTRAINT activity_group_alias_reason CHECK (reason = 'merge')
);
--> statement-breakpoint
CREATE INDEX activity_group_alias_user_group_idx ON fitness.activity_group_alias (user_id, group_id);
--> statement-breakpoint
ALTER TABLE fitness.activity ADD COLUMN group_id uuid;
--> statement-breakpoint
-- Run after a successful insert: conflict-only provider upserts must not
-- allocate unused groups. Existing group ownership is enforced by the FK.
CREATE FUNCTION fitness.ensure_activity_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id, created_at)
  VALUES (NEW.group_id, NEW.user_id, NEW.id, NEW.created_at)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER activity_ensure_group
AFTER INSERT ON fitness.activity
FOR EACH ROW EXECUTE FUNCTION fitness.ensure_activity_group();
--> statement-breakpoint
-- Reuse singleton allocation for the existing rows in this transaction only.
CREATE TRIGGER activity_backfill_group
AFTER UPDATE OF group_id ON fitness.activity
FOR EACH ROW EXECUTE FUNCTION fitness.ensure_activity_group();
--> statement-breakpoint
UPDATE fitness.activity SET group_id = id
WHERE group_id IS NULL;
--> statement-breakpoint
DROP TRIGGER activity_backfill_group ON fitness.activity;
--> statement-breakpoint
-- Capture membership from the existing view, whose public ID is still the
-- current representative. Replacing that view belongs to a later migration.
WITH visible_members AS MATERIALIZED (
  SELECT
    id AS group_id,
    user_id,
    unnest(member_activity_ids) AS activity_id
  FROM fitness.v_activity
)

UPDATE fitness.activity AS member
SET group_id = visible_members.group_id
FROM visible_members
WHERE
  member.id = visible_members.activity_id
  AND member.user_id = visible_members.user_id
  AND member.group_id IS DISTINCT FROM visible_members.group_id;
--> statement-breakpoint
DELETE FROM fitness.activity_group AS candidate
WHERE NOT EXISTS (
  SELECT 1 FROM fitness.activity AS member
  WHERE member.group_id = candidate.id
);
--> statement-breakpoint
ALTER TABLE fitness.activity
ADD CONSTRAINT activity_group_id_not_null
CHECK (group_id IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity
ADD CONSTRAINT activity_user_group_fk FOREIGN KEY (user_id, group_id)
REFERENCES fitness.activity_group (user_id, id)
DEFERRABLE INITIALLY DEFERRED NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity
VALIDATE CONSTRAINT activity_group_id_not_null;
--> statement-breakpoint
ALTER TABLE fitness.activity
VALIDATE CONSTRAINT activity_user_group_fk;
--> statement-breakpoint
ALTER TABLE fitness.activity
ALTER COLUMN group_id SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE fitness.activity
ALTER COLUMN group_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE fitness.activity
DROP CONSTRAINT activity_group_id_not_null;
--> statement-breakpoint
CREATE INDEX activity_user_group_idx ON fitness.activity (user_id, group_id);
