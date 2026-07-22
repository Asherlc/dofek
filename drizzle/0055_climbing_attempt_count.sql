ALTER TABLE fitness.climbing_entry
ADD COLUMN attempt_count integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
ADD CONSTRAINT climbing_entry_attempt_count_positive CHECK (attempt_count > 0);
