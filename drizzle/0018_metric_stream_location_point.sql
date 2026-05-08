CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS point public.geometry(Point, 4326);
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS latitude real;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS longitude real;
--> statement-breakpoint
ALTER TABLE fitness.metric_stream
ADD COLUMN IF NOT EXISTS metadata jsonb;
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE fitness.backfill_metric_stream_location_points(batch_size integer DEFAULT 50000)
LANGUAGE plpgsql
AS $$
DECLARE
  chunk_count integer;
  current_chunk_index integer := 1;
  current_chunk_regclass regclass;
  should_recompress boolean;
  chunk_has_legacy_location boolean;
  inserted_count integer;
  deleted_count integer;
BEGIN
  IF batch_size < 1 THEN
    RAISE EXCEPTION 'batch_size must be greater than zero';
  END IF;

  PERFORM set_config('lock_timeout', '5s', false);
  PERFORM set_config('statement_timeout', '0', false);
  PERFORM set_config('timescaledb.max_tuples_decompressed_per_dml_transaction', '0', false);

  DROP TABLE IF EXISTS pg_temp.metric_stream_location_backfill_chunks;
  CREATE TEMPORARY TABLE pg_temp.metric_stream_location_backfill_chunks ON COMMIT PRESERVE ROWS AS
  SELECT
    row_number() OVER (ORDER BY range_start NULLS FIRST, range_end NULLS LAST)::integer AS chunk_index,
    format('%I.%I', chunk_schema, chunk_name)::regclass AS chunk_regclass,
    is_compressed AS should_recompress
  FROM timescaledb_information.chunks
  WHERE hypertable_schema = 'fitness'
    AND hypertable_name = 'metric_stream';

  IF NOT EXISTS (SELECT 1 FROM pg_temp.metric_stream_location_backfill_chunks) THEN
    INSERT INTO pg_temp.metric_stream_location_backfill_chunks (chunk_index, chunk_regclass, should_recompress)
    VALUES (1, NULL, false);
  END IF;

  SELECT count(*)::integer INTO chunk_count
  FROM pg_temp.metric_stream_location_backfill_chunks;

  WHILE current_chunk_index <= chunk_count LOOP
    SELECT
      metric_stream_location_backfill_chunks.chunk_regclass,
      metric_stream_location_backfill_chunks.should_recompress
    INTO current_chunk_regclass, should_recompress
    FROM pg_temp.metric_stream_location_backfill_chunks
    WHERE metric_stream_location_backfill_chunks.chunk_index = current_chunk_index;

    IF current_chunk_regclass IS NULL THEN
      LOOP
        WITH source_rows AS (
          SELECT
            lat.recorded_at,
            lat.user_id,
            lat.provider_id,
            lat.device_id,
            lat.source_type,
            lat.activity_id,
            lat.tableoid AS lat_tableoid,
            lat.ctid AS lat_ctid,
            lng.tableoid AS lng_tableoid,
            lng.ctid AS lng_ctid,
            gps.tableoid AS gps_tableoid,
            gps.ctid AS gps_ctid,
            lat.scalar AS latitude,
            lng.scalar AS longitude,
            gps.scalar AS gps_accuracy_m
          FROM fitness.metric_stream AS lat
          INNER JOIN fitness.metric_stream AS lng
            ON lng.recorded_at = lat.recorded_at
           AND lng.user_id = lat.user_id
           AND lng.provider_id = lat.provider_id
           AND lng.source_type = lat.source_type
           AND lng.channel = 'lng'
           AND lng.activity_id IS NOT DISTINCT FROM lat.activity_id
           AND lng.device_id IS NOT DISTINCT FROM lat.device_id
          LEFT JOIN fitness.metric_stream AS gps
            ON gps.recorded_at = lat.recorded_at
           AND gps.user_id = lat.user_id
           AND gps.provider_id = lat.provider_id
           AND gps.source_type = lat.source_type
           AND gps.channel = 'gps_accuracy'
           AND gps.activity_id IS NOT DISTINCT FROM lat.activity_id
           AND gps.device_id IS NOT DISTINCT FROM lat.device_id
          WHERE lat.channel = 'lat'
            AND lat.scalar IS NOT NULL
            AND lng.scalar IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM fitness.metric_stream AS location
              WHERE location.recorded_at = lat.recorded_at
                AND location.user_id = lat.user_id
                AND location.provider_id = lat.provider_id
                AND location.source_type = lat.source_type
                AND location.channel = 'location'
                AND location.activity_id IS NOT DISTINCT FROM lat.activity_id
                AND location.device_id IS NOT DISTINCT FROM lat.device_id
            )
          LIMIT batch_size
        ),
        inserted_location_rows AS (
          INSERT INTO fitness.metric_stream (
            recorded_at,
            user_id,
            provider_id,
            device_id,
            source_type,
            channel,
            activity_id,
            point,
            latitude,
            longitude,
            metadata
          )
          SELECT
            source_rows.recorded_at,
            source_rows.user_id,
            source_rows.provider_id,
            source_rows.device_id,
            source_rows.source_type,
            'location',
            source_rows.activity_id,
            public.ST_SetSRID(
              public.ST_MakePoint(source_rows.longitude::double precision, source_rows.latitude::double precision),
              4326
            ),
            source_rows.latitude,
            source_rows.longitude,
            NULLIF(jsonb_strip_nulls(jsonb_build_object('gps_accuracy_m', source_rows.gps_accuracy_m)), '{}'::jsonb)
          FROM source_rows
          RETURNING 1
        ),
        legacy_rows_to_delete AS (
          SELECT source_rows.lat_tableoid AS row_tableoid, source_rows.lat_ctid AS row_ctid
          FROM source_rows
          UNION ALL
          SELECT source_rows.lng_tableoid, source_rows.lng_ctid
          FROM source_rows
          UNION ALL
          SELECT source_rows.gps_tableoid, source_rows.gps_ctid
          FROM source_rows
          WHERE source_rows.gps_ctid IS NOT NULL
        ),
        deleted_legacy_rows AS (
          DELETE FROM fitness.metric_stream AS legacy
          USING legacy_rows_to_delete
          WHERE legacy.tableoid = legacy_rows_to_delete.row_tableoid
            AND legacy.ctid = legacy_rows_to_delete.row_ctid
          RETURNING 1
        )
        SELECT
          (SELECT count(*)::integer FROM inserted_location_rows),
          (SELECT count(*)::integer FROM deleted_legacy_rows)
        INTO inserted_count, deleted_count;

        RAISE NOTICE 'metric_stream location backfill table fallback chunk %/% inserted % rows and deleted % legacy rows', current_chunk_index, chunk_count, inserted_count, deleted_count;
        COMMIT;

        EXIT WHEN inserted_count = 0;
      END LOOP;

      current_chunk_index := current_chunk_index + 1;
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %s
         WHERE channel IN (''lat'', ''lng'', ''gps_accuracy'')
           AND scalar IS NOT NULL
       )',
      current_chunk_regclass
    )
    INTO chunk_has_legacy_location;

    IF NOT chunk_has_legacy_location THEN
      RAISE NOTICE 'metric_stream location backfill chunk %/% skipped: no legacy location rows', current_chunk_index, chunk_count;
      current_chunk_index := current_chunk_index + 1;
      CONTINUE;
    END IF;

    IF should_recompress THEN
      PERFORM decompress_chunk(current_chunk_regclass, if_compressed => true);
      COMMIT;
    END IF;

    LOOP
      EXECUTE format(
        'WITH source_rows AS (
           SELECT
             lat.recorded_at,
             lat.user_id,
             lat.provider_id,
             lat.device_id,
             lat.source_type,
             lat.activity_id,
             lat.ctid AS lat_ctid,
             lng.ctid AS lng_ctid,
             gps.ctid AS gps_ctid,
             lat.scalar AS latitude,
             lng.scalar AS longitude,
             gps.scalar AS gps_accuracy_m
           FROM %1$s AS lat
           INNER JOIN %1$s AS lng
             ON lng.recorded_at = lat.recorded_at
            AND lng.user_id = lat.user_id
            AND lng.provider_id = lat.provider_id
            AND lng.source_type = lat.source_type
            AND lng.channel = ''lng''
            AND lng.activity_id IS NOT DISTINCT FROM lat.activity_id
            AND lng.device_id IS NOT DISTINCT FROM lat.device_id
           LEFT JOIN %1$s AS gps
             ON gps.recorded_at = lat.recorded_at
            AND gps.user_id = lat.user_id
            AND gps.provider_id = lat.provider_id
            AND gps.source_type = lat.source_type
            AND gps.channel = ''gps_accuracy''
            AND gps.activity_id IS NOT DISTINCT FROM lat.activity_id
            AND gps.device_id IS NOT DISTINCT FROM lat.device_id
           WHERE lat.channel = ''lat''
             AND lat.scalar IS NOT NULL
             AND lng.scalar IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM fitness.metric_stream AS location
               WHERE location.recorded_at = lat.recorded_at
                 AND location.user_id = lat.user_id
                 AND location.provider_id = lat.provider_id
                 AND location.source_type = lat.source_type
                 AND location.channel = ''location''
                 AND location.activity_id IS NOT DISTINCT FROM lat.activity_id
                 AND location.device_id IS NOT DISTINCT FROM lat.device_id
             )
           LIMIT $1
         ),
         inserted_location_rows AS (
           INSERT INTO fitness.metric_stream (
             recorded_at,
             user_id,
             provider_id,
             device_id,
             source_type,
             channel,
             activity_id,
             point,
             latitude,
             longitude,
             metadata
           )
           SELECT
             source_rows.recorded_at,
             source_rows.user_id,
             source_rows.provider_id,
             source_rows.device_id,
             source_rows.source_type,
             ''location'',
             source_rows.activity_id,
             public.ST_SetSRID(
               public.ST_MakePoint(source_rows.longitude::double precision, source_rows.latitude::double precision),
               4326
             ),
             source_rows.latitude,
             source_rows.longitude,
             NULLIF(jsonb_strip_nulls(jsonb_build_object(''gps_accuracy_m'', source_rows.gps_accuracy_m)), ''{}''::jsonb)
           FROM source_rows
           RETURNING 1
         ),
         legacy_rows_to_delete AS (
           SELECT source_rows.lat_ctid AS row_ctid
           FROM source_rows
           UNION ALL
           SELECT source_rows.lng_ctid
           FROM source_rows
           UNION ALL
           SELECT source_rows.gps_ctid
           FROM source_rows
           WHERE source_rows.gps_ctid IS NOT NULL
         ),
         deleted_legacy_rows AS (
           DELETE FROM %1$s AS legacy
           USING legacy_rows_to_delete
           WHERE legacy.ctid = legacy_rows_to_delete.row_ctid
           RETURNING 1
         )
         SELECT
           (SELECT count(*)::integer FROM inserted_location_rows),
           (SELECT count(*)::integer FROM deleted_legacy_rows)',
        current_chunk_regclass
      )
      INTO inserted_count, deleted_count
      USING batch_size;

      RAISE NOTICE 'metric_stream location backfill chunk %/% inserted % rows and deleted % legacy rows', current_chunk_index, chunk_count, inserted_count, deleted_count;
      COMMIT;

      EXIT WHEN inserted_count = 0;
    END LOOP;

    IF should_recompress THEN
      PERFORM compress_chunk(current_chunk_regclass, if_not_compressed => true);
      COMMIT;
    END IF;

    current_chunk_index := current_chunk_index + 1;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL fitness.backfill_metric_stream_location_points(50000);
--> statement-breakpoint
DROP PROCEDURE fitness.backfill_metric_stream_location_points(integer);
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET timescaledb.max_tuples_decompressed_per_dml_transaction;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS metric_stream_point_gist_idx
ON fitness.metric_stream
USING gist (point)
WHERE point IS NOT NULL;
