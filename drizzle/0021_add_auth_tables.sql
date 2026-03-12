-- ============================================================
-- Migration 0021: Authentication tables for multi-user OIDC
-- ============================================================
-- 1. auth_account — links external OAuth identities to user_profile
-- 2. session — database-backed sessions
-- 3. Alter user_settings to scope by user_id

-- ============================================================
-- 1. auth_account
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.auth_account (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES fitness.user_profile(id) ON DELETE CASCADE,
  auth_provider       TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  email               TEXT,
  name                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_account_provider_id_idx
  ON fitness.auth_account (auth_provider, provider_account_id);
CREATE INDEX IF NOT EXISTS auth_account_user_idx
  ON fitness.auth_account (user_id);

--> statement-breakpoint

-- ============================================================
-- 2. session
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.session (
  id         TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES fitness.user_profile(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_user_idx ON fitness.session (user_id);
CREATE INDEX IF NOT EXISTS session_expires_idx ON fitness.session (expires_at);

--> statement-breakpoint

-- ============================================================
-- 3. Scope user_settings by user_id
-- ============================================================

-- Add user_id column (defaulting existing rows to the default user)
ALTER TABLE fitness.user_settings
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

-- Replace the single-column PK with a composite PK
-- Drop old PK first, then create new one
ALTER TABLE fitness.user_settings DROP CONSTRAINT IF EXISTS user_settings_pkey;
ALTER TABLE fitness.user_settings ADD PRIMARY KEY (user_id, key);
