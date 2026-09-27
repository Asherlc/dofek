ALTER TABLE fitness.activity
  ADD CONSTRAINT activity_user_id_idx UNIQUE (user_id, id);
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
  ADD COLUMN user_id uuid,
  ADD COLUMN provider_id text,
  ADD COLUMN unattached_date date,
  ADD COLUMN provider_absent_at timestamptz;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
  ALTER COLUMN activity_id DROP NOT NULL;
--> statement-breakpoint
UPDATE fitness.activity AS parent
SET deleted_at = COALESCE(parent.deleted_at, now())
WHERE parent.provider_id = 'mountain-project'
  AND EXISTS (
    SELECT 1 FROM fitness.climbing_entry AS entry
    WHERE entry.activity_id = parent.id
  );
--> statement-breakpoint
UPDATE fitness.climbing_entry AS entry
SET
  user_id = parent.user_id,
  provider_id = parent.provider_id,
  provider_absent_at = parent.provider_absent_at,
  unattached_date = CASE
    WHEN parent.provider_id = 'mountain-project'
      THEN (parent.started_at AT TIME ZONE 'UTC')::date
    ELSE NULL
  END,
  activity_id = CASE
    WHEN parent.provider_id = 'mountain-project' THEN NULL
    ELSE entry.activity_id
  END
FROM fitness.activity AS parent
WHERE parent.id = entry.activity_id;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN provider_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
  DROP CONSTRAINT climbing_entry_activity_id_fkey;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
  ADD CONSTRAINT climbing_entry_user_id_user_profile_id_fk
    FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id),
  ADD CONSTRAINT climbing_entry_provider_id_provider_id_fk
    FOREIGN KEY (provider_id) REFERENCES fitness.provider (id),
  ADD CONSTRAINT climbing_entry_activity_unattached_date_pair
    CHECK ((activity_id IS NULL) = (unattached_date IS NOT NULL)),
  ADD CONSTRAINT climbing_entry_activity_owner_fk
    FOREIGN KEY (user_id, activity_id) REFERENCES fitness.activity (user_id, id)
    ON DELETE CASCADE;
--> statement-breakpoint
DROP INDEX fitness.climbing_entry_activity_external_id_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX climbing_entry_user_provider_external_id_idx
  ON fitness.climbing_entry (user_id, provider_id, external_id)
  WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX climbing_entry_unattached_date_idx
  ON fitness.climbing_entry (user_id, unattached_date)
  WHERE activity_id IS NULL AND provider_absent_at IS NULL;
