CREATE TABLE fitness.running_race_result (
  user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
  provider_id text NOT NULL REFERENCES fitness.provider(id),
  source_activity_id text NOT NULL,
  source_name text,
  source_sport text NOT NULL,
  source_date_time text NOT NULL,
  distance_meters double precision NOT NULL,
  finish_seconds double precision NOT NULL,
  PRIMARY KEY (user_id, provider_id, source_activity_id)
);
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
