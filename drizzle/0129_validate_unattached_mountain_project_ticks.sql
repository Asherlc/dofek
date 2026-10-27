ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_user_id_present;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_provider_id_present;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_user_id_user_profile_id_fk;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_provider_id_provider_id_fk;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_activity_unattached_date_pair;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_activity_owner_fk;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
ALTER COLUMN user_id SET NOT NULL,
ALTER COLUMN provider_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
DROP CONSTRAINT climbing_entry_user_id_present,
DROP CONSTRAINT climbing_entry_provider_id_present;
