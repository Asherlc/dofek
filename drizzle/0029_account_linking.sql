-- Add index on auth_account.email for email-based account linking lookups
CREATE INDEX IF NOT EXISTS auth_account_email_idx ON fitness.auth_account (email) WHERE email IS NOT NULL;
