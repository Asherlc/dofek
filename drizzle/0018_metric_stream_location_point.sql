CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS point public.GEOMETRY (POINT, 4326);
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS latitude real;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS longitude real;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS metadata jsonb;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS fitness.backfill_metric_stream_location_points(integer);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS metric_stream_point_gist_idx
ON fitness.metric_stream
USING gist (point)
WHERE point IS NOT NULL;
