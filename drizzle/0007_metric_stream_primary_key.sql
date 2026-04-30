ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS id uuid;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ALTER COLUMN id SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
REPLICA IDENTITY FULL;
--> statement-breakpoint
UPDATE fitness.metric_stream
SET id = gen_random_uuid()
WHERE id IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'fitness.metric_stream'::regclass
      AND conname = 'metric_stream_pkey'
  ) THEN
    ALTER TABLE fitness.metric_stream
    ADD CONSTRAINT metric_stream_pkey PRIMARY KEY (id, recorded_at);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
REPLICA IDENTITY USING INDEX metric_stream_pkey;
