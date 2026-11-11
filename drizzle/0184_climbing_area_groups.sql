CREATE TABLE fitness.area_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX area_group_owner_id_idx ON fitness.area_group (user_id, id);
--> statement-breakpoint
ALTER TABLE fitness.area ADD COLUMN group_id uuid;
--> statement-breakpoint
ALTER TABLE fitness.area ADD CONSTRAINT area_group_owner_fk
FOREIGN KEY (user_id, group_id) REFERENCES fitness.area_group (user_id, id);
--> statement-breakpoint
CREATE INDEX area_group_idx ON fitness.area (group_id);
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
