ALTER TABLE fitness.climbing_entry
-- A per-climb attempt count cannot approach the 32-bit integer limit.
-- squawk-ignore prefer-bigint-over-int
ADD COLUMN attempt_count integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
ADD CONSTRAINT climbing_entry_attempt_count_positive CHECK (attempt_count > 0) NOT VALID;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_attempt_count_positive;
