ALTER TABLE fitness.user_billing
ADD COLUMN stripe_subscription_event_id text,
ADD COLUMN stripe_subscription_event_created bigint;
--> statement-breakpoint

CREATE TABLE fitness.stripe_webhook_event (
  event_id text PRIMARY KEY,
  event_created bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
