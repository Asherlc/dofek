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
  chunk_start timestamptz;
  chunk_end timestamptz;
  current_chunk_is_compressed boolean;
  updated_count integer;
BEGIN
  IF batch_size < 1 THEN
    RAISE EXCEPTION 'batch_size must be greater than zero';
  END IF;

  PERFORM set_config('lock_timeout', '5s', false);
  PERFORM set_config('statement_timeout', '0', false);
  PERFORM set_config('timescaledb.max_tuples_decompressed_per_dml_transaction', '0', false);

  DROP TABLE IF EXISTS pg_temp.metric_stream_backfill_chunks;
  CREATE TEMPORARY TABLE pg_temp.metric_stream_backfill_chunks ON COMMIT PRESERVE ROWS AS
  SELECT
    row_number() OVER (ORDER BY range_start NULLS FIRST, range_end NULLS LAST)::integer AS chunk_index,
    range_start::timestamptz AS range_start,
    range_end::timestamptz AS range_end,
    is_compressed
  FROM timescaledb_information.chunks
  WHERE hypertable_schema = 'fitness'
    AND hypertable_name = 'metric_stream';

  IF NOT EXISTS (SELECT 1 FROM pg_temp.metric_stream_backfill_chunks) THEN
    INSERT INTO pg_temp.metric_stream_backfill_chunks (chunk_index, range_start, range_end, is_compressed)
    VALUES (1, NULL, NULL, false);
  END IF;

  SELECT count(*)::integer INTO chunk_count
  FROM pg_temp.metric_stream_backfill_chunks;

  WHILE current_chunk_index <= chunk_count LOOP
    SELECT range_start, range_end, is_compressed
    INTO chunk_start, chunk_end, current_chunk_is_compressed
    FROM pg_temp.metric_stream_backfill_chunks
    WHERE metric_stream_backfill_chunks.chunk_index = current_chunk_index;

    IF current_chunk_is_compressed THEN
      UPDATE fitness.metric_stream
      SET id = gen_random_uuid()
      WHERE id IS NULL
        AND recorded_at >= chunk_start
        AND recorded_at < chunk_end;

      GET DIAGNOSTICS updated_count = ROW_COUNT;
      RAISE NOTICE 'metric_stream id backfill chunk %/% updated % rows', current_chunk_index, chunk_count, updated_count;
      COMMIT;
    ELSE
      LOOP
        IF chunk_start IS NULL OR chunk_end IS NULL THEN
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
        ELSE
          WITH target_rows AS (
            SELECT tableoid, ctid
            FROM fitness.metric_stream
            WHERE id IS NULL
              AND recorded_at >= chunk_start
              AND recorded_at < chunk_end
            LIMIT batch_size
          )
          UPDATE fitness.metric_stream AS metric_stream
          SET id = gen_random_uuid()
          FROM target_rows
          WHERE metric_stream.tableoid = target_rows.tableoid
            AND metric_stream.ctid = target_rows.ctid;
        END IF;

        GET DIAGNOSTICS updated_count = ROW_COUNT;
        RAISE NOTICE 'metric_stream id backfill chunk %/% updated % rows', current_chunk_index, chunk_count, updated_count;
        COMMIT;

        EXIT WHEN updated_count = 0;
      END LOOP;
    END IF;

    current_chunk_index := current_chunk_index + 1;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL fitness.backfill_metric_stream_ids(50000);
--> statement-breakpoint
DROP PROCEDURE fitness.backfill_metric_stream_ids(integer);
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET timescaledb.max_tuples_decompressed_per_dml_transaction;
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
