CREATE UNIQUE INDEX climbing_log_entry_owner_provider_id_idx
ON fitness.climbing_log_entry (user_id, provider_id, id);
--> statement-breakpoint
-- Approved migration-local exception: readers and writers now support exactly
-- one Activity or ClimbingLogEntry owner. Existing rows keep their Activity.
-- Constraints remain fully validated; validation can block writes until commit.
-- https://www.postgresql.org/docs/current/sql-altertable.html
ALTER TABLE fitness.activity_image
-- squawk-ignore ban-drop-not-null
ALTER COLUMN activity_id DROP NOT NULL,
ADD COLUMN climbing_log_entry_id uuid,
-- squawk-ignore constraint-missing-not-valid
ADD CONSTRAINT activity_image_one_owner
CHECK (num_nonnulls(activity_id, climbing_log_entry_id) = 1),
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
ADD CONSTRAINT activity_image_owned_climbing_log_fk
FOREIGN KEY (user_id, provider_id, climbing_log_entry_id)
REFERENCES fitness.climbing_log_entry (user_id, provider_id, id)
ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX activity_image_climbing_source_idx
ON fitness.activity_image (user_id, climbing_log_entry_id, provider_id, source_id);
--> statement-breakpoint
-- Approved migration-local exception for the same owner contract and atomic
-- validation as activity_image above; no database constraints are disabled.
-- https://www.postgresql.org/docs/current/sql-altertable.html
ALTER TABLE fitness.activity_image_discovery
-- squawk-ignore ban-drop-not-null
ALTER COLUMN activity_id DROP NOT NULL,
ADD COLUMN climbing_log_entry_id uuid,
-- squawk-ignore constraint-missing-not-valid
ADD CONSTRAINT activity_image_discovery_one_owner
CHECK (num_nonnulls(activity_id, climbing_log_entry_id) = 1),
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
ADD CONSTRAINT activity_image_discovery_owned_climbing_log_fk
FOREIGN KEY (user_id, provider_id, climbing_log_entry_id)
REFERENCES fitness.climbing_log_entry (user_id, provider_id, id)
ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX activity_image_discovery_climbing_source_idx
ON fitness.activity_image_discovery (user_id, climbing_log_entry_id, provider_id);
