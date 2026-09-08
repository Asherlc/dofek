ALTER TABLE fitness.strength_set
ADD COLUMN raw jsonb DEFAULT '{}'::jsonb NOT NULL;
