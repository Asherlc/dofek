ALTER TABLE "fitness"."oauth_token"
  ADD COLUMN "provider_account_id" text,
  ADD CONSTRAINT "oauth_token_provider_account_id_nonempty"
    CHECK (
      "provider_account_id" IS NULL
      OR length("provider_account_id") > 0
    );
--> statement-breakpoint
CREATE TABLE "fitness"."account_erasure_preparation" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "request_id" uuid NOT NULL,
  "preparation_token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_preparation_request_idx"
  ON "fitness"."account_erasure_preparation" USING btree ("request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_preparation_token_idx"
  ON "fitness"."account_erasure_preparation" USING btree ("preparation_token_hash");
--> statement-breakpoint
CREATE TABLE "fitness"."account_erasure_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "user_hash" text NOT NULL,
  "user_hash_key_id" text NOT NULL,
  "write_fence_hash" text NOT NULL,
  "preparation_token_hash" text,
  "status_token_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "current_phase" text,
  "encrypted_remote_snapshot" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "replay_retained_until" timestamp with time zone NOT NULL,
  "completion_deadline" timestamp with time zone NOT NULL,
  "retry_at" timestamp with time zone,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "phase_progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "failure_count" bigint DEFAULT 0 NOT NULL,
  "recovered_from_restore" timestamp with time zone,
  "started_at" timestamp with time zone,
  "pii_scrubbed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "last_error" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_erasure_request_status_valid"
    CHECK ("status" IN ('pending', 'running', 'waiting_replay', 'waiting_retention', 'failed', 'completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_request_active_user_idx"
  ON "fitness"."account_erasure_request" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_request_write_fence_idx"
  ON "fitness"."account_erasure_request" USING btree ("write_fence_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_request_preparation_token_idx"
  ON "fitness"."account_erasure_request" USING btree ("preparation_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_request_status_token_idx"
  ON "fitness"."account_erasure_request" USING btree ("status_token_hash");
--> statement-breakpoint
CREATE INDEX "account_erasure_request_status_retry_idx"
  ON "fitness"."account_erasure_request" USING btree ("status", "retry_at");
--> statement-breakpoint
CREATE TABLE "fitness"."account_erasure_checkpoint" (
  "request_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "details" jsonb,
  "completed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_erasure_checkpoint_request_id_phase_pk"
    PRIMARY KEY ("request_id", "phase"),
  CONSTRAINT "account_erasure_checkpoint_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "fitness"."account_erasure_request"("id")
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE "fitness"."account_erasure_outbox" (
  "request_id" uuid PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  CONSTRAINT "account_erasure_outbox_status_valid"
    CHECK ("status" IN ('pending', 'dispatched')),
  CONSTRAINT "account_erasure_outbox_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "fitness"."account_erasure_request"("id")
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "account_erasure_outbox_pending_idx"
  ON "fitness"."account_erasure_outbox" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE TABLE "fitness"."account_erasure_identity_fence" (
  "request_id" uuid NOT NULL,
  "identity_kind" text NOT NULL,
  "key_id" text NOT NULL,
  "identity_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_erasure_identity_fence_pk"
    PRIMARY KEY ("identity_kind", "key_id", "identity_hash"),
  CONSTRAINT "account_erasure_identity_fence_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "fitness"."account_erasure_request"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "account_erasure_identity_fence_kind_valid"
    CHECK ("identity_kind" IN ('provider_account', 'email'))
);
--> statement-breakpoint
CREATE INDEX "account_erasure_identity_fence_request_idx"
  ON "fitness"."account_erasure_identity_fence" USING btree ("request_id");
--> statement-breakpoint
ALTER TABLE "fitness"."auth_account"
  ADD COLUMN "revocation_access_token" text,
  ADD COLUMN "revocation_refresh_token" text,
  ADD COLUMN "revocation_client_id" text;
--> statement-breakpoint
CREATE TABLE "fitness"."user_external_effect" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "system" text NOT NULL,
  "resource_type" text NOT NULL,
  "external_id" text NOT NULL,
  "contact_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_external_effect_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "fitness"."user_profile"("id")
    ON DELETE CASCADE,
  CONSTRAINT "user_external_effect_supported_resource"
    CHECK (
      ("system" = 'stripe' AND "resource_type" = 'customer')
      OR ("system" = 'zoho_desk' AND "resource_type" = 'ticket')
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_external_effect_resource_idx"
  ON "fitness"."user_external_effect" USING btree (
    "system", "resource_type", "external_id"
  );
--> statement-breakpoint
CREATE INDEX "user_external_effect_user_idx"
  ON "fitness"."user_external_effect" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_alias_id_exercise_idx"
  ON "fitness"."exercise_alias" USING btree ("id", "exercise_id");
--> statement-breakpoint
CREATE TABLE "fitness"."exercise_source" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "exercise_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "user_id" uuid,
  "provider_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "exercise_source_exercise_id_fkey"
    FOREIGN KEY ("exercise_id") REFERENCES "fitness"."exercise"("id")
    ON DELETE CASCADE,
  CONSTRAINT "exercise_source_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "fitness"."user_profile"("id")
    ON DELETE CASCADE,
  CONSTRAINT "exercise_source_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id"),
  CONSTRAINT "exercise_source_shape_valid"
    CHECK (
      (
        "source_kind" = 'system'
        AND "user_id" IS NULL
        AND "provider_id" IS NULL
      )
      OR (
        "source_kind" = 'user'
        AND "user_id" IS NOT NULL
        AND "provider_id" IS NOT NULL
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_source_id_exercise_idx"
  ON "fitness"."exercise_source" USING btree ("id", "exercise_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_source_system_idx"
  ON "fitness"."exercise_source" USING btree ("exercise_id")
  WHERE "source_kind" = 'system';
--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_source_user_provider_idx"
  ON "fitness"."exercise_source" USING btree (
    "exercise_id", "user_id", "provider_id"
  )
  WHERE "source_kind" = 'user';
--> statement-breakpoint
CREATE INDEX "exercise_source_user_idx"
  ON "fitness"."exercise_source" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "fitness"."exercise_alias_source" (
  "alias_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "exercise_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "exercise_alias_source_pk"
    PRIMARY KEY ("alias_id", "source_id"),
  CONSTRAINT "exercise_alias_source_alias_fkey"
    FOREIGN KEY ("alias_id", "exercise_id")
    REFERENCES "fitness"."exercise_alias"("id", "exercise_id")
    ON DELETE CASCADE,
  CONSTRAINT "exercise_alias_source_source_fkey"
    FOREIGN KEY ("source_id", "exercise_id")
    REFERENCES "fitness"."exercise_source"("id", "exercise_id")
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "exercise_alias_source_exercise_idx"
  ON "fitness"."exercise_alias_source" USING btree ("exercise_id");
--> statement-breakpoint
CREATE INDEX "exercise_alias_source_source_idx"
  ON "fitness"."exercise_alias_source" USING btree ("source_id");
--> statement-breakpoint
CREATE TABLE "fitness"."slack_team_membership" (
  "team_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "slack_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "slack_team_membership_pk"
    PRIMARY KEY ("team_id", "user_id"),
  CONSTRAINT "slack_team_membership_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "fitness"."slack_installation"("team_id")
    ON DELETE CASCADE,
  CONSTRAINT "slack_team_membership_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "fitness"."user_profile"("id")
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "slack_team_membership_identity_idx"
  ON "fitness"."slack_team_membership" USING btree (
    "team_id", "slack_user_id"
  );
--> statement-breakpoint
CREATE INDEX "slack_team_membership_user_idx"
  ON "fitness"."slack_team_membership" USING btree ("user_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fitness"."lock_and_reject_account_erasure_write"(
  target_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  erasure_request_id uuid;
BEGIN
  IF target_user_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));
  erasure_request_id := NULLIF(
    current_setting('dofek.account_erasure_request_id', true),
    ''
  )::uuid;
  IF erasure_request_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM fitness.account_erasure_request
      WHERE id = erasure_request_id
        AND user_id = target_user_id
        AND status <> 'completed'
    )
  THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM fitness.account_erasure_request
    WHERE (
        user_id = target_user_id
        AND status <> 'completed'
      )
      OR write_fence_hash = encode(
        public.digest(target_user_id::text, 'sha256'),
        'hex'
      )
  ) THEN
    RAISE EXCEPTION 'Account erasure is active for user %', target_user_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fitness"."reject_account_erasure_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_user_id uuid;
BEGIN
  FOR target_user_id IN
    SELECT DISTINCT candidate_user_id
    FROM unnest(
      ARRAY[
        NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid,
        CASE
          WHEN TG_OP = 'UPDATE' THEN NULLIF(to_jsonb(OLD) ->> TG_ARGV[0], '')::uuid
          ELSE NULL
        END
      ]
    ) AS candidate_user_id
    WHERE candidate_user_id IS NOT NULL
    ORDER BY candidate_user_id
  LOOP
    PERFORM fitness.lock_and_reject_account_erasure_write(target_user_id);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fitness"."account_erasure_relation_is_ownership_neutral"(
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fitness"."resolve_account_erasure_owner_ids"(
  target_table oid,
  target_row jsonb,
  visited_tables oid[] DEFAULT ARRAY[]::oid[]
)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  child_value text;
  column_index integer;
  direct_owner_user_id uuid;
  join_predicate text;
  parent_row jsonb;
  relationship record;
  relationship_is_set boolean;
  target_namespace name;
  target_relation name;
BEGIN
  IF target_table IS NULL
    OR target_table = ANY(visited_tables)
    OR fitness.account_erasure_relation_is_ownership_neutral(target_table)
  THEN
    RETURN;
  END IF;

  SELECT namespace.nspname, relation.relname
  INTO target_namespace, target_relation
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.oid = target_table
    AND namespace.nspname IN ('fitness', 'analytics')
    AND relation.relkind IN ('r', 'p');
  IF target_namespace IS NULL THEN
    RETURN;
  END IF;

  IF target_namespace = 'fitness' AND target_relation = 'user_profile' THEN
    direct_owner_user_id := NULLIF(target_row ->> 'id', '')::uuid;
    IF direct_owner_user_id IS NOT NULL THEN
      RETURN NEXT direct_owner_user_id;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attribute AS column_definition
    WHERE column_definition.attrelid = target_table
      AND column_definition.attname = 'user_id'
      AND column_definition.attnum > 0
      AND NOT column_definition.attisdropped
  ) THEN
    direct_owner_user_id := NULLIF(target_row ->> 'user_id', '')::uuid;
    IF direct_owner_user_id IS NOT NULL THEN
      RETURN NEXT direct_owner_user_id;
    END IF;
  END IF;

  FOR relationship IN
    SELECT
      parent.oid AS parent_oid,
      parent.relname AS parent_table,
      parent_namespace.nspname AS parent_schema,
      array_agg(child_column.attname ORDER BY key_column.ordinality)
        AS child_columns,
      array_agg(parent_column.attname ORDER BY key_column.ordinality)
        AS parent_columns
    FROM pg_constraint AS foreign_key
    JOIN pg_class AS child ON child.oid = foreign_key.conrelid
    JOIN pg_namespace AS child_namespace
      ON child_namespace.oid = child.relnamespace
    JOIN pg_class AS parent ON parent.oid = foreign_key.confrelid
    JOIN pg_namespace AS parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    CROSS JOIN LATERAL unnest(
      foreign_key.conkey,
      foreign_key.confkey
    ) WITH ORDINALITY AS key_column(
      child_attribute_number,
      parent_attribute_number,
      ordinality
    )
    JOIN pg_attribute AS child_column
      ON child_column.attrelid = child.oid
      AND child_column.attnum = key_column.child_attribute_number
    JOIN pg_attribute AS parent_column
      ON parent_column.attrelid = parent.oid
      AND parent_column.attnum = key_column.parent_attribute_number
    WHERE foreign_key.contype = 'f'
      AND foreign_key.conrelid = target_table
      AND child_namespace.nspname IN ('fitness', 'analytics')
      AND parent_namespace.nspname IN ('fitness', 'analytics')
      AND NOT fitness.account_erasure_relation_is_ownership_neutral(parent.oid)
    GROUP BY
      foreign_key.oid,
      parent.oid,
      parent.relname,
      parent_namespace.nspname
    ORDER BY foreign_key.oid
  LOOP
    join_predicate := '';
    relationship_is_set := true;
    FOR column_index IN 1..cardinality(relationship.child_columns)
    LOOP
      child_value := target_row ->> relationship.child_columns[column_index];
      IF child_value IS NULL THEN
        relationship_is_set := false;
        EXIT;
      END IF;
      IF join_predicate <> '' THEN
        join_predicate := join_predicate || ' AND ';
      END IF;
      join_predicate := join_predicate || format(
        'account_erasure_parent.%I = %L',
        relationship.parent_columns[column_index],
        child_value
      );
    END LOOP;
    IF NOT relationship_is_set THEN
      CONTINUE;
    END IF;

    FOR parent_row IN EXECUTE format(
      'SELECT to_jsonb(account_erasure_parent)
       FROM %I.%I AS account_erasure_parent
       WHERE %s',
      relationship.parent_schema,
      relationship.parent_table,
      join_predicate
    )
    LOOP
      RETURN QUERY
      SELECT nested_owner_id
      FROM fitness.resolve_account_erasure_owner_ids(
        relationship.parent_oid,
        parent_row,
        visited_tables || target_table
      ) AS nested_owner_id;
    END LOOP;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fitness"."reject_transitive_account_erasure_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_user_id uuid;
BEGIN
  FOR target_user_id IN
    SELECT DISTINCT owner_id
    FROM (
      SELECT owner_id
      FROM fitness.resolve_account_erasure_owner_ids(
        TG_RELID,
        to_jsonb(NEW)
      ) AS owner_id
      UNION
      SELECT owner_id
      FROM fitness.resolve_account_erasure_owner_ids(
        TG_RELID,
        CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END
      ) AS owner_id
    ) AS candidate_owner
    WHERE owner_id IS NOT NULL
    ORDER BY owner_id
  LOOP
    PERFORM fitness.lock_and_reject_account_erasure_write(target_user_id);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fitness"."reject_slack_team_erasure_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_request_id uuid;
  erasure_request_id uuid;
  target_team_id text;
  target_user_id uuid;
BEGIN
  erasure_request_id := NULLIF(
    current_setting('dofek.account_erasure_request_id', true),
    ''
  )::uuid;
  FOR target_team_id IN
    SELECT DISTINCT team_id
    FROM unnest(
      ARRAY[
        NULLIF(to_jsonb(NEW) ->> 'team_id', ''),
        CASE
          WHEN TG_OP IN ('UPDATE', 'DELETE')
          THEN NULLIF(to_jsonb(OLD) ->> 'team_id', '')
          ELSE NULL
        END
      ]
    ) AS team_id
    WHERE team_id IS NOT NULL
    ORDER BY team_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'account-erasure-slack-team:' || target_team_id,
        0
      )
    );
    IF erasure_request_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM fitness.account_erasure_request AS current_request
        WHERE current_request.id = erasure_request_id
          AND current_request.status <> 'completed'
          AND (
            (
              TG_TABLE_NAME = 'slack_team_membership'
              AND TG_OP = 'DELETE'
              AND current_request.user_id =
                NULLIF(to_jsonb(OLD) ->> 'user_id', '')::uuid
            )
            OR (
              TG_TABLE_NAME = 'slack_installation'
              AND TG_OP = 'UPDATE'
              AND EXISTS (
                SELECT 1
                FROM fitness.slack_team_membership AS current_membership
                WHERE current_membership.user_id = current_request.user_id
                  AND current_membership.team_id = target_team_id
              )
            )
          )
      )
    THEN
      CONTINUE;
    END IF;
    FOR active_request_id, target_user_id IN
      SELECT request.id, membership.user_id
      FROM fitness.slack_team_membership AS membership
      JOIN fitness.account_erasure_request AS request
        ON request.user_id = membership.user_id
        AND request.status <> 'completed'
      WHERE membership.team_id = target_team_id
      ORDER BY request.id
    LOOP
      IF erasure_request_id = active_request_id THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended(target_user_id::text, 0)
        );
        RAISE EXCEPTION
          'Account erasure is active for user %',
          target_user_id
          USING ERRCODE = '55000';
      END IF;
      PERFORM fitness.lock_and_reject_account_erasure_write(target_user_id);
    END LOOP;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fitness"."refresh_account_erasure_write_fences"()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  direct_table record;
  managed_table record;
  transitive_table record;
BEGIN
  FOR managed_table IN
    SELECT
      relation.oid,
      relation.relname AS table_name,
      namespace.nspname AS schema_name
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('fitness', 'analytics')
      AND relation.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS account_erasure_write_fence ON %I.%I',
      managed_table.schema_name,
      managed_table.table_name
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS account_erasure_transitive_write_fence ON %I.%I',
      managed_table.schema_name,
      managed_table.table_name
    );
  END LOOP;

  FOR direct_table IN
    SELECT
      relation.relname AS table_name,
      namespace.nspname AS schema_name,
      CASE
        WHEN namespace.nspname = 'fitness'
          AND relation.relname = 'user_profile'
        THEN 'id'
        ELSE 'user_id'
      END AS owner_column
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('fitness', 'analytics')
      AND relation.relkind IN ('r', 'p')
      AND NOT fitness.account_erasure_relation_is_ownership_neutral(
        relation.oid
      )
      AND (
        (
          namespace.nspname = 'fitness'
          AND relation.relname = 'user_profile'
        )
        OR EXISTS (
          SELECT 1
          FROM pg_attribute AS owner_column
          WHERE owner_column.attrelid = relation.oid
            AND owner_column.attname = 'user_id'
            AND owner_column.attnum > 0
            AND NOT owner_column.attisdropped
        )
      )
    ORDER BY namespace.nspname, relation.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER account_erasure_write_fence
       BEFORE INSERT OR UPDATE ON %I.%I
       FOR EACH ROW EXECUTE FUNCTION fitness.reject_account_erasure_write(%L)',
      direct_table.schema_name,
      direct_table.table_name,
      direct_table.owner_column
    );
  END LOOP;

  FOR transitive_table IN
    WITH RECURSIVE direct_owned AS (
      SELECT relation.oid
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('fitness', 'analytics')
        AND relation.relkind IN ('r', 'p')
        AND NOT fitness.account_erasure_relation_is_ownership_neutral(
          relation.oid
        )
        AND (
          (
            namespace.nspname = 'fitness'
            AND relation.relname = 'user_profile'
          )
          OR EXISTS (
            SELECT 1
            FROM pg_attribute AS owner_column
            WHERE owner_column.attrelid = relation.oid
              AND owner_column.attname = 'user_id'
              AND owner_column.attnum > 0
              AND NOT owner_column.attisdropped
          )
        )
    ),
    owned AS (
      SELECT oid FROM direct_owned
      UNION
      SELECT child.oid
      FROM owned AS parent_owner
      JOIN pg_constraint AS foreign_key
        ON foreign_key.confrelid = parent_owner.oid
        AND foreign_key.contype = 'f'
      JOIN pg_class AS child ON child.oid = foreign_key.conrelid
      JOIN pg_namespace AS child_namespace
        ON child_namespace.oid = child.relnamespace
      JOIN pg_class AS parent ON parent.oid = foreign_key.confrelid
      JOIN pg_namespace AS parent_namespace
        ON parent_namespace.oid = parent.relnamespace
      WHERE child_namespace.nspname IN ('fitness', 'analytics')
        AND parent_namespace.nspname IN ('fitness', 'analytics')
        AND child.relkind IN ('r', 'p')
        AND NOT fitness.account_erasure_relation_is_ownership_neutral(
          child.oid
        )
    )
    SELECT
      relation.relname AS table_name,
      namespace.nspname AS schema_name
    FROM owned
    JOIN pg_class AS relation ON relation.oid = owned.oid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE NOT EXISTS (
      SELECT 1
      FROM direct_owned
      WHERE direct_owned.oid = owned.oid
    )
    ORDER BY namespace.nspname, relation.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER account_erasure_transitive_write_fence
       BEFORE INSERT OR UPDATE ON %I.%I
       FOR EACH ROW EXECUTE FUNCTION fitness.reject_transitive_account_erasure_write()',
      transitive_table.schema_name,
      transitive_table.table_name
    );
  END LOOP;

  DROP TRIGGER IF EXISTS account_erasure_slack_team_write_fence
    ON fitness.slack_installation;
  CREATE TRIGGER account_erasure_slack_team_write_fence
    BEFORE INSERT OR UPDATE OR DELETE ON fitness.slack_installation
    FOR EACH ROW EXECUTE FUNCTION fitness.reject_slack_team_erasure_write();

  DROP TRIGGER IF EXISTS account_erasure_slack_team_write_fence
    ON fitness.slack_team_membership;
  CREATE TRIGGER account_erasure_slack_team_write_fence
    BEFORE INSERT OR UPDATE OR DELETE ON fitness.slack_team_membership
    FOR EACH ROW EXECUTE FUNCTION fitness.reject_slack_team_erasure_write();
END;
$$;
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
