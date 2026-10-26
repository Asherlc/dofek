CREATE UNIQUE INDEX climbing_log_entry_owner_provider_id_idx
ON fitness.climbing_log_entry (user_id, provider_id, id);
--> statement-breakpoint
ALTER TABLE fitness.activity_image
ALTER COLUMN activity_id DROP NOT NULL,
ADD COLUMN climbing_log_entry_id uuid,
ADD CONSTRAINT activity_image_one_owner
CHECK (num_nonnulls(activity_id, climbing_log_entry_id) = 1),
ADD CONSTRAINT activity_image_owned_climbing_log_fk
FOREIGN KEY (user_id, provider_id, climbing_log_entry_id)
REFERENCES fitness.climbing_log_entry (user_id, provider_id, id)
ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX activity_image_climbing_source_idx
ON fitness.activity_image (user_id, climbing_log_entry_id, provider_id, source_id);
--> statement-breakpoint
ALTER TABLE fitness.activity_image_discovery
ALTER COLUMN activity_id DROP NOT NULL,
ADD COLUMN climbing_log_entry_id uuid,
ADD CONSTRAINT activity_image_discovery_one_owner
CHECK (num_nonnulls(activity_id, climbing_log_entry_id) = 1),
ADD CONSTRAINT activity_image_discovery_owned_climbing_log_fk
FOREIGN KEY (user_id, provider_id, climbing_log_entry_id)
REFERENCES fitness.climbing_log_entry (user_id, provider_id, id)
ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX activity_image_discovery_climbing_source_idx
ON fitness.activity_image_discovery (user_id, climbing_log_entry_id, provider_id);
