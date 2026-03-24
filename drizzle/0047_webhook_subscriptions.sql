-- Webhook subscription tracking for push-based provider syncs
CREATE TABLE IF NOT EXISTS fitness.webhook_subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT REFERENCES fitness.provider(id),
  provider_name TEXT NOT NULL,
  subscription_external_id TEXT,
  verify_token TEXT NOT NULL,
  signing_secret TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One subscription per provider connection
CREATE UNIQUE INDEX IF NOT EXISTS webhook_subscription_provider_id_idx
  ON fitness.webhook_subscription (provider_id);

-- Look up subscriptions by provider name (for app-level webhooks)
CREATE INDEX IF NOT EXISTS webhook_subscription_provider_name_idx
  ON fitness.webhook_subscription (provider_name);
