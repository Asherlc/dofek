-- Slack ownership moved to the standalone target-agnostic bot.
-- Rebuild the catalog-derived fence function without the removed Slack tables
-- before the migration runner invokes it after applying all migrations.
CREATE OR REPLACE FUNCTION fitness.refresh_account_erasure_write_fences()
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
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS account_erasure_slack_team_write_fence
ON fitness.slack_team_membership;
DROP TRIGGER IF EXISTS account_erasure_slack_team_write_fence
ON fitness.slack_installation;
DROP TABLE IF EXISTS fitness.slack_team_membership;
DROP TABLE IF EXISTS fitness.slack_installation;
DROP FUNCTION IF EXISTS fitness.reject_slack_team_erasure_write();
