ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS id uuid;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ALTER COLUMN id SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
REPLICA IDENTITY FULL;
