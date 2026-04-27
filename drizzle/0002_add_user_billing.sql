CREATE TABLE IF NOT EXISTS fitness.user_billing (
  user_id uuid PRIMARY KEY REFERENCES fitness.user_profile(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_subscription_status text,
  stripe_current_period_end timestamptz,
  paid_grant_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_billing_stripe_customer_idx ON fitness.user_billing(stripe_customer_id);
CREATE INDEX user_billing_stripe_subscription_idx ON fitness.user_billing(stripe_subscription_id);

INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
SELECT id, 'existing_account'
FROM fitness.user_profile
ON CONFLICT (user_id) DO NOTHING;
