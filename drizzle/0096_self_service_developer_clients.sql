ALTER TABLE fitness.external_client
  ADD COLUMN owner_user_id uuid
    REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  ADD COLUMN last_rotated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX external_client_owner_idx
ON fitness.external_client (owner_user_id);
--> statement-breakpoint
CREATE INDEX external_client_last_rotated_idx
ON fitness.external_client (last_rotated_at);
--> statement-breakpoint
CREATE TABLE fitness.external_client_redirect_uri (
  client_id text NOT NULL
    REFERENCES fitness.external_client (client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  PRIMARY KEY (client_id, redirect_uri),
  CONSTRAINT external_client_redirect_uri_https_check
    CHECK (redirect_uri ~ '^https://[^[:space:]]+$')
);
--> statement-breakpoint
CREATE INDEX external_client_redirect_uri_client_idx
ON fitness.external_client_redirect_uri (client_id);
--> statement-breakpoint
CREATE TABLE fitness.external_client_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL
    REFERENCES fitness.external_client (client_id) ON DELETE CASCADE,
  actor_user_id uuid
    REFERENCES fitness.user_profile (id) ON DELETE SET NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_client_audit_action_check
    CHECK (action IN ('create', 'update', 'rotate', 'revoke'))
);
--> statement-breakpoint
CREATE INDEX external_client_audit_client_occurred_idx
ON fitness.external_client_audit (client_id, occurred_at DESC);
--> statement-breakpoint
UPDATE fitness.external_client
SET revoked_at = COALESCE(revoked_at, now()),
    updated_at = now()
WHERE owner_user_id IS NULL
  AND revoked_at IS NULL;
--> statement-breakpoint
UPDATE fitness.external_grant AS grant_record
SET revoked_at = now()
FROM fitness.external_client AS client
WHERE grant_record.client_id = client.client_id
  AND client.owner_user_id IS NULL
  AND grant_record.revoked_at IS NULL;
--> statement-breakpoint
ALTER TABLE fitness.external_client
  ADD CONSTRAINT external_client_active_owner_check
  CHECK (owner_user_id IS NOT NULL OR revoked_at IS NOT NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fitness.account_erasure_relation_is_ownership_neutral(
  target_table oid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT namespace.nspname = 'fitness'
        AND (
          relation.relname LIKE 'account_erasure_%'
          OR relation.relname IN (
            'exercise',
            'exercise_alias',
            'provider',
            'slack_installation'
          )
        )
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.oid = target_table
    ),
    true
  );
$$;
