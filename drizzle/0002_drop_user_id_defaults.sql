DO $$
DECLARE
  table_record RECORD;
BEGIN
  FOR table_record IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'fitness'
      AND column_name = 'user_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
      table_record.table_schema,
      table_record.table_name,
      table_record.column_name
    );
  END LOOP;
END $$;
