ALTER TABLE fitness.oauth_token
  ALTER COLUMN user_id SET NOT NULL;

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'fitness.oauth_token'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE fitness.oauth_token
      ADD CONSTRAINT oauth_token_pkey PRIMARY KEY USING INDEX oauth_token_user_provider_uidx;
  END IF;
END;
$$;
