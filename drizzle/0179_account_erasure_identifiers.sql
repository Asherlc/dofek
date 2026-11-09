-- dofek: deployment-mode=maintenance
-- Old request producers and workers must remain quiesced through runtime cutover.
LOCK TABLE fitness.account_erasure_request IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  identifying_count bigint;
  user_id_count bigint;
  snapshot_count bigint;
  unscrubbed_count bigint;
BEGIN
  SELECT
    count(*) FILTER (
      WHERE status <> 'completed'
        OR user_id IS NOT NULL
        OR encrypted_remote_snapshot IS NOT NULL
        OR pii_scrubbed_at IS NULL
    ),
    count(*) FILTER (WHERE user_id IS NOT NULL),
    count(*) FILTER (WHERE encrypted_remote_snapshot IS NOT NULL),
    count(*) FILTER (WHERE pii_scrubbed_at IS NULL)
  INTO identifying_count, user_id_count, snapshot_count, unscrubbed_count
  FROM fitness.account_erasure_request;

  IF identifying_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'Account erasure identifier cutover blocked: %s unfinished, identifying or unconverted request(s) (user_ids=%s, retained_snapshots=%s, unscrubbed=%s). Keep request producers and old workers quiesced; drain unfinished requests with their original workers before retrying migration 0179. No request data was converted; unresolved recovery requires an approved plan.',
        identifying_count, user_id_count, snapshot_count, unscrubbed_count
      );
  END IF;
END;
$$;
--> statement-breakpoint
CREATE TABLE fitness.account_erasure_identifier (
  request_id uuid NOT NULL REFERENCES fitness.account_erasure_request (id) ON DELETE CASCADE,
  family text NOT NULL,
  identity_key text NOT NULL,
  encrypted_identifier text NOT NULL,
  PRIMARY KEY (request_id, family, identity_key),
  CONSTRAINT account_erasure_identifier_family CHECK (family IN ('activity', 'sleep', 'operation', 'group_string', 'physical_intent', 'physical_part', 'physical_mutation')),
  CONSTRAINT account_erasure_identifier_key CHECK (identity_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT account_erasure_identifier_encrypted CHECK (encrypted_identifier LIKE 'enc:v1:%')
);
