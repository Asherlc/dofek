CREATE TABLE fitness.provider_data_generation (
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  current_generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_data_generation_pkey PRIMARY KEY (user_id, provider_id),
  CONSTRAINT provider_data_generation_nonnegative CHECK (current_generation >= 0)
);
--> statement-breakpoint

CREATE TABLE fitness.provider_data_deletion_outbox (
  event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  generation bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT provider_data_deletion_outbox_generation_positive CHECK (generation > 0),
  CONSTRAINT provider_data_deletion_outbox_status_valid
  CHECK (status IN ('pending', 'dispatched', 'completed'))
);
--> statement-breakpoint

CREATE INDEX provider_data_deletion_outbox_dispatch_idx
ON fitness.provider_data_deletion_outbox (status, created_at);
