CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS id uuid;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ALTER COLUMN id SET DEFAULT gen_random_uuid();
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE fitness.backfill_metric_stream_ids(batch_size integer DEFAULT 50000)
LANGUAGE plpgsql
AS $$
DECLARE
  chunk_count integer;
  current_chunk_index integer := 1;
  current_chunk_regclass regclass;
  previous_replication_role text;
  should_recompress boolean;
  chunk_has_missing_ids boolean;
  updated_count integer;
BEGIN
  IF batch_size < 1 THEN
    RAISE EXCEPTION 'batch_size must be greater than zero';
  END IF;

  PERFORM set_config('lock_timeout', '5s', false);
  PERFORM set_config('statement_timeout', '0', false);
  PERFORM set_config('timescaledb.max_tuples_decompressed_per_dml_transaction', '0', false);

  IF NOT EXISTS (
    SELECT 1
    FROM fitness.metric_stream
    WHERE id IS NULL
    LIMIT 1
  ) THEN
    RAISE NOTICE 'metric_stream id backfill skipped: no NULL ids remain';
    RETURN;
  END IF;

  previous_replication_role := current_setting('session_replication_role');
  PERFORM set_config('session_replication_role', 'replica', false);

  DROP TABLE IF EXISTS pg_temp.metric_stream_backfill_chunks;
  CREATE TEMPORARY TABLE pg_temp.metric_stream_backfill_chunks ON COMMIT PRESERVE ROWS AS
  SELECT
    row_number() OVER (ORDER BY range_start NULLS FIRST, range_end NULLS LAST)::integer AS chunk_index,
    format('%I.%I', chunk_schema, chunk_name)::regclass AS chunk_regclass,
    range_start::timestamptz AS range_start,
    range_end::timestamptz AS range_end,
    is_compressed AS should_recompress
  FROM timescaledb_information.chunks
  WHERE hypertable_schema = 'fitness'
    AND hypertable_name = 'metric_stream';

  IF NOT EXISTS (SELECT 1 FROM pg_temp.metric_stream_backfill_chunks) THEN
    INSERT INTO pg_temp.metric_stream_backfill_chunks (chunk_index, chunk_regclass, range_start, range_end, should_recompress)
    VALUES (1, NULL, NULL, NULL, false);
  END IF;

  SELECT count(*)::integer INTO chunk_count
  FROM pg_temp.metric_stream_backfill_chunks;

  WHILE current_chunk_index <= chunk_count LOOP
    SELECT
      metric_stream_backfill_chunks.chunk_regclass,
      metric_stream_backfill_chunks.should_recompress
    INTO current_chunk_regclass, should_recompress
    FROM pg_temp.metric_stream_backfill_chunks
    WHERE metric_stream_backfill_chunks.chunk_index = current_chunk_index;

    IF current_chunk_regclass IS NULL THEN
      LOOP
        WITH target_rows AS (
          SELECT tableoid, ctid
          FROM fitness.metric_stream
          WHERE id IS NULL
          LIMIT batch_size
        )
        UPDATE fitness.metric_stream AS metric_stream
        SET id = gen_random_uuid()
        FROM target_rows
        WHERE metric_stream.tableoid = target_rows.tableoid
          AND metric_stream.ctid = target_rows.ctid;

        GET DIAGNOSTICS updated_count = ROW_COUNT;
        RAISE NOTICE 'metric_stream id backfill table fallback chunk %/% updated % rows', current_chunk_index, chunk_count, updated_count;
        EXIT WHEN updated_count = 0;
      END LOOP;

      current_chunk_index := current_chunk_index + 1;
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %s
         WHERE id IS NULL
       )',
      current_chunk_regclass
    )
    INTO chunk_has_missing_ids;

    IF NOT chunk_has_missing_ids THEN
      RAISE NOTICE 'metric_stream id backfill chunk %/% skipped: no NULL ids', current_chunk_index, chunk_count;
      current_chunk_index := current_chunk_index + 1;
      CONTINUE;
    END IF;

    IF current_chunk_regclass IS NOT NULL THEN
      PERFORM decompress_chunk(current_chunk_regclass, if_compressed => true);
    END IF;

    LOOP
      EXECUTE format(
        'WITH target_rows AS (
           SELECT ctid
           FROM %s
           WHERE id IS NULL
           LIMIT $1
         )
         UPDATE %s AS metric_stream
         SET id = gen_random_uuid()
         FROM target_rows
         WHERE metric_stream.ctid = target_rows.ctid',
        current_chunk_regclass,
        current_chunk_regclass
      )
      USING batch_size;

      GET DIAGNOSTICS updated_count = ROW_COUNT;
      RAISE NOTICE 'metric_stream id backfill chunk %/% updated % rows', current_chunk_index, chunk_count, updated_count;
      EXIT WHEN updated_count = 0;
    END LOOP;

    IF current_chunk_regclass IS NOT NULL AND should_recompress THEN
      PERFORM compress_chunk(current_chunk_regclass, if_not_compressed => true);
    END IF;

    current_chunk_index := current_chunk_index + 1;
  END LOOP;

  PERFORM set_config('session_replication_role', previous_replication_role, false);
END;
$$;
--> statement-breakpoint
CALL fitness.backfill_metric_stream_ids(500000);
--> statement-breakpoint
DROP PROCEDURE fitness.backfill_metric_stream_ids(integer);
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET timescaledb.max_tuples_decompressed_per_dml_transaction;
--> statement-breakpoint
RESET session_replication_role;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM fitness.metric_stream
    WHERE id IS NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'fitness.metric_stream.id backfill incomplete: NULL ids remain';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ALTER COLUMN id SET NOT NULL;
--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
-- squawk-ignore adding-serial-primary-key-field
-- Timescale hypertables reject the recommended CREATE INDEX CONCURRENTLY and
-- PRIMARY KEY USING INDEX alternatives, so use the supported direct form.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'fitness.metric_stream'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE fitness.metric_stream
    ADD CONSTRAINT metric_stream_pkey PRIMARY KEY (id, recorded_at);
  END IF;
END;
$$;
