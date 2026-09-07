CREATE FUNCTION fitness.human_record_fields_valid(decisions jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  decision jsonb;
BEGIN
  IF jsonb_typeof(decisions) <> 'object' THEN
    RETURN false;
  END IF;
  FOR decision IN SELECT value FROM jsonb_each(decisions) LOOP
    IF jsonb_typeof(decision) <> 'object' THEN
      RETURN false;
    END IF;
    IF decision = '{"operation":"clear"}'::jsonb THEN
      CONTINUE;
    END IF;
    IF decision ->> 'operation' = 'set'
      AND decision ? 'value'
      AND decision - 'operation' - 'value' = '{}'::jsonb
      AND jsonb_typeof(decision -> 'value') IN ('string', 'number', 'boolean', 'null')
    THEN
      CONTINUE;
    END IF;
    RETURN false;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE TABLE fitness.human_record_identity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  domain text NOT NULL,
  namespace text NOT NULL,
  source_key text NOT NULL,
  CONSTRAINT human_record_identity_source_key UNIQUE (user_id, domain, namespace, source_key),
  CONSTRAINT human_record_identity_owner_key UNIQUE (id, user_id),
  CONSTRAINT human_record_identity_parts_nonempty CHECK (
    length(btrim(domain)) > 0 AND length(btrim(namespace)) > 0 AND length(btrim(source_key)) > 0
  )
);
--> statement-breakpoint
CREATE TABLE fitness.human_record_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL,
  channel text NOT NULL,
  client_id text,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  effective_at timestamp with time zone,
  schema_version bigint NOT NULL,
  undo_change_id uuid,
  CONSTRAINT human_record_change_request_key UNIQUE (user_id, request_id),
  CONSTRAINT human_record_change_owner_key UNIQUE (id, user_id),
  CONSTRAINT human_record_change_undo_fk FOREIGN KEY (undo_change_id, user_id)
  REFERENCES fitness.human_record_change (id, user_id),
  CONSTRAINT human_record_change_hash_valid CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT human_record_change_kind_valid CHECK (kind IN ('create', 'update', 'clear', 'delete', 'restore', 'undo', 'legacy_delete')),
  CONSTRAINT human_record_change_channel_valid CHECK (channel IN ('web', 'mobile', 'mcp', 'migration')),
  CONSTRAINT human_record_change_client_valid CHECK (channel <> 'mcp' OR (client_id IS NOT NULL AND length(btrim(client_id)) > 0)),
  CONSTRAINT human_record_change_version_positive CHECK (schema_version > 0)
);
--> statement-breakpoint
CREATE TABLE fitness.human_record_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  change_id uuid NOT NULL,
  predecessor_id uuid,
  fields jsonb DEFAULT '{}'::jsonb NOT NULL,
  deleted boolean,
  CONSTRAINT human_record_target_change_key UNIQUE (identity_id, change_id),
  CONSTRAINT human_record_target_successor_key UNIQUE NULLS NOT DISTINCT (identity_id, predecessor_id),
  CONSTRAINT human_record_target_owner_key UNIQUE (id, identity_id, user_id),
  CONSTRAINT human_record_target_identity_fk FOREIGN KEY (identity_id, user_id)
  REFERENCES fitness.human_record_identity (id, user_id),
  CONSTRAINT human_record_target_change_fk FOREIGN KEY (change_id, user_id)
  REFERENCES fitness.human_record_change (id, user_id),
  CONSTRAINT human_record_target_predecessor_fk FOREIGN KEY (predecessor_id, identity_id, user_id)
  REFERENCES fitness.human_record_target (id, identity_id, user_id),
  CONSTRAINT human_record_target_not_self CHECK (predecessor_id IS NULL OR predecessor_id <> id),
  CONSTRAINT human_record_target_fields_valid CHECK (fitness.human_record_fields_valid(fields))
);
--> statement-breakpoint
CREATE FUNCTION fitness.require_human_record_predecessor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.predecessor_id = NEW.id THEN
    RAISE EXCEPTION 'A human record target cannot be its own predecessor'
      USING ERRCODE = '23514', CONSTRAINT = 'human_record_target_not_self';
  END IF;
  IF NEW.predecessor_id IS NOT NULL THEN
    PERFORM 1 FROM fitness.human_record_target
    WHERE id = NEW.predecessor_id
      AND identity_id = NEW.identity_id
      AND user_id = NEW.user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Human record predecessor must already exist for this identity and user'
        USING ERRCODE = '23503', CONSTRAINT = 'human_record_target_predecessor_fk';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER human_record_target_existing_predecessor
BEFORE INSERT ON fitness.human_record_target
FOR EACH ROW EXECUTE FUNCTION fitness.require_human_record_predecessor();
--> statement-breakpoint
CREATE FUNCTION fitness.reject_human_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM fitness.account_erasure_request
      WHERE id = NULLIF(current_setting('dofek.account_erasure_request_id', true), '')::uuid
        AND user_id = OLD.user_id
        AND status <> 'completed'
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only; deletion requires verified account erasure', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER human_record_identity_append_only
BEFORE UPDATE OR DELETE ON fitness.human_record_identity
FOR EACH ROW EXECUTE FUNCTION fitness.reject_human_record_mutation();
--> statement-breakpoint
CREATE TRIGGER human_record_change_append_only
BEFORE UPDATE OR DELETE ON fitness.human_record_change
FOR EACH ROW EXECUTE FUNCTION fitness.reject_human_record_mutation();
--> statement-breakpoint
CREATE TRIGGER human_record_target_append_only
BEFORE UPDATE OR DELETE ON fitness.human_record_target
FOR EACH ROW EXECUTE FUNCTION fitness.reject_human_record_mutation();
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
