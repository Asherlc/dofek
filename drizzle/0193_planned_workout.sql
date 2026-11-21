CREATE TABLE fitness.planned_workout (
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE cascade,
  provider_id text NOT NULL REFERENCES fitness.provider (id),
  external_id text NOT NULL,
  start_date date NOT NULL,
  start_time time,
  title text,
  description text,
  sport_type text,
  workout_doc jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planned_workout_pkey PRIMARY KEY (user_id, provider_id, external_id)
);
--> statement-breakpoint
CREATE INDEX planned_workout_user_date_idx ON fitness.planned_workout (user_id, start_date);
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
