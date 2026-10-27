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
            'slack_installation',
            'external_client'
          )
        )
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.oid = target_table
    ),
    true
  );
$$;
