CREATE TABLE fitness.external_client (
  client_id text PRIMARY KEY,
  name text NOT NULL,
  secret_hash text NOT NULL,
  scopes text[] NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fitness.external_link (
  link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES fitness.external_client (client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  requested_scopes text[] NOT NULL,
  state text,
  expires_at timestamptz NOT NULL,
  user_id uuid REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  code_hash text UNIQUE,
  code_expires_at timestamptz,
  approved_at timestamptz,
  exchanged_at timestamptz,
  approval_csrf_hash text,
  approval_session_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX external_link_expiry_idx ON fitness.external_link (expires_at);

CREATE TABLE fitness.external_identity_link (
  namespace text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  opaque_subject text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, subject)
);

CREATE TABLE fitness.external_grant (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES fitness.external_client (client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  namespace text NOT NULL,
  subject text NOT NULL,
  opaque_subject text NOT NULL,
  access_token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX external_grant_lookup_idx
  ON fitness.external_grant (client_id, namespace, subject, revoked_at, created_at DESC);

CREATE TABLE fitness.external_idempotency_receipt (
  grant_id uuid NOT NULL REFERENCES fitness.external_grant (grant_id) ON DELETE CASCADE,
  method text NOT NULL,
  path text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_json jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, method, path, idempotency_key)
);

CREATE INDEX external_idempotency_receipt_completed_at_idx
  ON fitness.external_idempotency_receipt (completed_at)
  WHERE status = 'completed';

CREATE TABLE fitness.external_erasure_ack (
  event_id text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES fitness.external_grant (grant_id) ON DELETE CASCADE,
  result text NOT NULL CHECK (result IN ('completed', 'failed')),
  reason_code text,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);

SELECT fitness.refresh_account_erasure_write_fences();
