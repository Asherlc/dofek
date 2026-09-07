ALTER TABLE fitness.health_event
ADD COLUMN IF NOT EXISTS source_bundle text,
ADD COLUMN IF NOT EXISTS metadata jsonb;
