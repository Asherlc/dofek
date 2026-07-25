ALTER TABLE fitness.provider
ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

CREATE TABLE fitness.provider_connection (
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES fitness.provider (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_connection_pkey PRIMARY KEY (user_id, provider_id)
);
--> statement-breakpoint

CREATE INDEX provider_connection_provider_idx
ON fitness.provider_connection (provider_id);
--> statement-breakpoint

CREATE TABLE fitness.provider_connection_backfill_progress (
  source_table text PRIMARY KEY,
  last_user_id uuid,
  last_provider_id text,
  rows_inserted bigint NOT NULL DEFAULT 0,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE fitness.webhook_subscription
ADD COLUMN user_id uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX webhook_subscription_app_provider_name_idx
ON fitness.webhook_subscription (provider_name)
WHERE user_id IS NULL AND status = 'active';
--> statement-breakpoint

CREATE UNIQUE INDEX webhook_subscription_user_provider_idx
ON fitness.webhook_subscription (user_id, provider_id)
WHERE user_id IS NOT NULL AND provider_id IS NOT NULL AND status = 'active';
