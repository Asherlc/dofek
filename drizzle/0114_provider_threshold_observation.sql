CREATE TABLE fitness.provider_threshold_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES fitness.provider (id) ON DELETE CASCADE,
  provider_record_id text NOT NULL,
  sport text NOT NULL,
  threshold_type text NOT NULL,
  value real NOT NULL,
  unit text NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  effective_at timestamp with time zone,
  raw jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT provider_threshold_observation_value_positive CHECK (value > 0),
  CONSTRAINT provider_threshold_observation_identity_nonempty CHECK (
    length(btrim(provider_record_id)) > 0
    AND length(btrim(sport)) > 0
    AND length(btrim(threshold_type)) > 0
    AND length(btrim(unit)) > 0
  )
);
--> statement-breakpoint
CREATE INDEX provider_threshold_observation_history_idx
ON fitness.provider_threshold_observation (
  user_id,
  sport,
  threshold_type,
  observed_at DESC
);
--> statement-breakpoint
CREATE INDEX provider_threshold_observation_source_idx
ON fitness.provider_threshold_observation (
  user_id,
  provider_id,
  provider_record_id,
  threshold_type,
  observed_at DESC
);
