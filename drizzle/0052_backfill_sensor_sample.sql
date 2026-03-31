-- ============================================================
-- Migration 0052: Backfill sensor_sample from legacy tables
-- ============================================================
-- Previous implementation ran in one long transaction and could:
-- 1) hold relation locks for a long time
-- 2) consume excessive temporary/WAL disk space
-- 3) fail without resumability
--
-- This version is resumable and chunked:
-- - tracks progress in drizzle.sensor_sample_backfill_progress
-- - commits after each chunk
-- - resumes from the last committed cursor on retry

CREATE SCHEMA IF NOT EXISTS drizzle;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS drizzle.sensor_sample_backfill_progress (
  source_name text PRIMARY KEY,
  next_cursor timestamptz,
  max_source_time timestamptz,
  rows_inserted bigint NOT NULL DEFAULT 0,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE OR REPLACE PROCEDURE drizzle.backfill_metric_stream_to_sensor_sample(
  batch_interval interval DEFAULT INTERVAL '2 hours'
)
LANGUAGE plpgsql
AS $$
DECLARE
  min_time timestamptz;
  max_time timestamptz;
  next_cursor timestamptz;
  chunk_start timestamptz;
  chunk_end timestamptz;
  chunk_rows bigint;
  total_rows bigint;
BEGIN
  SELECT MIN(recorded_at), MAX(recorded_at) INTO min_time, max_time
  FROM fitness.metric_stream;

  IF min_time IS NULL THEN
    INSERT INTO drizzle.sensor_sample_backfill_progress (
      source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
    )
    VALUES ('metric_stream', NULL, NULL, 0, now(), now())
    ON CONFLICT (source_name) DO UPDATE
      SET finished_at = now(), updated_at = now();
    COMMIT;
    RETURN;
  END IF;

  SELECT
    COALESCE(progress.next_cursor, min_time),
    COALESCE(progress.rows_inserted, 0)
  INTO next_cursor, total_rows
  FROM drizzle.sensor_sample_backfill_progress AS progress
  WHERE progress.source_name = 'metric_stream';

  IF next_cursor IS NULL OR next_cursor < min_time THEN
    next_cursor := min_time;
  END IF;
  IF total_rows IS NULL THEN
    total_rows := 0;
  END IF;

  LOOP
    SELECT metric.recorded_at
    INTO chunk_start
    FROM fitness.metric_stream AS metric
    WHERE metric.recorded_at >= next_cursor
      AND metric.recorded_at <= max_time
    ORDER BY metric.recorded_at
    LIMIT 1;

    EXIT WHEN chunk_start IS NULL;

    chunk_end := chunk_start + batch_interval;

    INSERT INTO fitness.sensor_sample (
      recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
    )
    SELECT
      expanded.recorded_at,
      expanded.user_id,
      expanded.provider_id,
      expanded.source_name,
      CASE expanded.provider_id
        WHEN 'whoop_ble' THEN 'ble'
        WHEN 'apple_health' THEN 'file'
        ELSE 'api'
      END,
      expanded.channel,
      expanded.activity_id,
      expanded.value
    FROM (
      SELECT
        metric.recorded_at,
        metric.user_id,
        metric.provider_id,
        metric.source_name,
        metric.activity_id,
        unnest(ARRAY[
          'heart_rate',
          'power',
          'cadence',
          'speed',
          'lat',
          'lng',
          'altitude',
          'temperature',
          'grade',
          'vertical_speed',
          'spo2',
          'respiratory_rate',
          'gps_accuracy',
          'accumulated_power',
          'stress',
          'left_right_balance',
          'vertical_oscillation',
          'stance_time',
          'stance_time_percent',
          'step_length',
          'vertical_ratio',
          'stance_time_balance',
          'ground_contact_time',
          'stride_length',
          'form_power',
          'leg_spring_stiff',
          'air_power',
          'left_torque_effectiveness',
          'right_torque_effectiveness',
          'left_pedal_smoothness',
          'right_pedal_smoothness',
          'combined_pedal_smoothness',
          'blood_glucose',
          'audio_exposure',
          'skin_temperature',
          'electrodermal_activity'
        ]) AS channel,
        unnest(ARRAY[
          metric.heart_rate::real,
          metric.power::real,
          metric.cadence::real,
          metric.speed,
          metric.lat,
          metric.lng,
          metric.altitude,
          metric.temperature,
          metric.grade,
          metric.vertical_speed,
          metric.spo2,
          metric.respiratory_rate,
          metric.gps_accuracy::real,
          metric.accumulated_power::real,
          metric.stress::real,
          metric.left_right_balance,
          metric.vertical_oscillation,
          metric.stance_time,
          metric.stance_time_percent,
          metric.step_length,
          metric.vertical_ratio,
          metric.stance_time_balance,
          metric.ground_contact_time,
          metric.stride_length,
          metric.form_power,
          metric.leg_spring_stiff,
          metric.air_power,
          metric.left_torque_effectiveness,
          metric.right_torque_effectiveness,
          metric.left_pedal_smoothness,
          metric.right_pedal_smoothness,
          metric.combined_pedal_smoothness,
          metric.blood_glucose,
          metric.audio_exposure,
          metric.skin_temperature,
          metric.electrodermal_activity
        ]) AS value
      FROM fitness.metric_stream AS metric
      WHERE metric.recorded_at >= chunk_start
        AND metric.recorded_at < chunk_end
    ) AS expanded
    WHERE expanded.value IS NOT NULL;

    GET DIAGNOSTICS chunk_rows = ROW_COUNT;
    total_rows := total_rows + chunk_rows;
    next_cursor := chunk_end;

    INSERT INTO drizzle.sensor_sample_backfill_progress (
      source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
    )
    VALUES ('metric_stream', next_cursor, max_time, total_rows, NULL, now())
    ON CONFLICT (source_name) DO UPDATE
      SET
        next_cursor = EXCLUDED.next_cursor,
        max_source_time = EXCLUDED.max_source_time,
        rows_inserted = EXCLUDED.rows_inserted,
        finished_at = NULL,
        updated_at = now();

    RAISE NOTICE 'metric_stream backfill: % to % -> % rows (total: %)',
      chunk_start, chunk_end, chunk_rows, total_rows;

    COMMIT;
  END LOOP;

  INSERT INTO drizzle.sensor_sample_backfill_progress (
    source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
  )
  VALUES ('metric_stream', next_cursor, max_time, total_rows, now(), now())
  ON CONFLICT (source_name) DO UPDATE
    SET
      next_cursor = EXCLUDED.next_cursor,
      max_source_time = EXCLUDED.max_source_time,
      rows_inserted = EXCLUDED.rows_inserted,
      finished_at = EXCLUDED.finished_at,
      updated_at = EXCLUDED.updated_at;

  RAISE NOTICE 'metric_stream backfill complete: % total sensor_sample rows', total_rows;

  COMMIT;
END;
$$;

--> statement-breakpoint

CREATE OR REPLACE PROCEDURE drizzle.backfill_imu_to_sensor_sample(
  batch_interval interval DEFAULT INTERVAL '30 minutes'
)
LANGUAGE plpgsql
AS $$
DECLARE
  min_time timestamptz;
  max_time timestamptz;
  next_cursor timestamptz;
  chunk_start timestamptz;
  chunk_end timestamptz;
  chunk_rows bigint;
  total_rows bigint;
BEGIN
  SELECT MIN(recorded_at), MAX(recorded_at) INTO min_time, max_time
  FROM fitness.inertial_measurement_unit_sample;

  IF min_time IS NULL THEN
    INSERT INTO drizzle.sensor_sample_backfill_progress (
      source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
    )
    VALUES ('imu', NULL, NULL, 0, now(), now())
    ON CONFLICT (source_name) DO UPDATE
      SET finished_at = now(), updated_at = now();
    COMMIT;
    RETURN;
  END IF;

  SELECT
    COALESCE(progress.next_cursor, min_time),
    COALESCE(progress.rows_inserted, 0)
  INTO next_cursor, total_rows
  FROM drizzle.sensor_sample_backfill_progress AS progress
  WHERE progress.source_name = 'imu';

  IF next_cursor IS NULL OR next_cursor < min_time THEN
    next_cursor := min_time;
  END IF;
  IF total_rows IS NULL THEN
    total_rows := 0;
  END IF;

  LOOP
    SELECT sample.recorded_at
    INTO chunk_start
    FROM fitness.inertial_measurement_unit_sample AS sample
    WHERE sample.recorded_at >= next_cursor
      AND sample.recorded_at <= max_time
    ORDER BY sample.recorded_at
    LIMIT 1;

    EXIT WHEN chunk_start IS NULL;

    chunk_end := chunk_start + batch_interval;

    INSERT INTO fitness.sensor_sample (
      recorded_at, user_id, provider_id, device_id, source_type, channel, vector
    )
    SELECT
      sample.recorded_at,
      sample.user_id,
      sample.provider_id,
      sample.device_id,
      CASE sample.device_type
        WHEN 'whoop' THEN 'ble'
        ELSE 'api'
      END,
      CASE
        WHEN sample.gyroscope_x IS NOT NULL THEN 'imu'
        ELSE 'accel'
      END,
      CASE
        WHEN sample.gyroscope_x IS NOT NULL
          THEN ARRAY[
            sample.x,
            sample.y,
            sample.z,
            COALESCE(sample.gyroscope_x, 0),
            COALESCE(sample.gyroscope_y, 0),
            COALESCE(sample.gyroscope_z, 0)
          ]
        ELSE ARRAY[sample.x, sample.y, sample.z]
      END
    FROM fitness.inertial_measurement_unit_sample AS sample
    WHERE sample.recorded_at >= chunk_start
      AND sample.recorded_at < chunk_end;

    GET DIAGNOSTICS chunk_rows = ROW_COUNT;
    total_rows := total_rows + chunk_rows;
    next_cursor := chunk_end;

    INSERT INTO drizzle.sensor_sample_backfill_progress (
      source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
    )
    VALUES ('imu', next_cursor, max_time, total_rows, NULL, now())
    ON CONFLICT (source_name) DO UPDATE
      SET
        next_cursor = EXCLUDED.next_cursor,
        max_source_time = EXCLUDED.max_source_time,
        rows_inserted = EXCLUDED.rows_inserted,
        finished_at = NULL,
        updated_at = now();

    RAISE NOTICE 'IMU backfill: % to % -> % rows (total: %)',
      chunk_start, chunk_end, chunk_rows, total_rows;

    COMMIT;
  END LOOP;

  INSERT INTO drizzle.sensor_sample_backfill_progress (
    source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
  )
  VALUES ('imu', next_cursor, max_time, total_rows, now(), now())
  ON CONFLICT (source_name) DO UPDATE
    SET
      next_cursor = EXCLUDED.next_cursor,
      max_source_time = EXCLUDED.max_source_time,
      rows_inserted = EXCLUDED.rows_inserted,
      finished_at = EXCLUDED.finished_at,
      updated_at = EXCLUDED.updated_at;

  RAISE NOTICE 'IMU backfill complete: % total sensor_sample rows', total_rows;

  COMMIT;
END;
$$;

--> statement-breakpoint

CREATE OR REPLACE PROCEDURE drizzle.backfill_orientation_to_sensor_sample(
  batch_interval interval DEFAULT INTERVAL '2 hours'
)
LANGUAGE plpgsql
AS $$
DECLARE
  min_time timestamptz;
  max_time timestamptz;
  next_cursor timestamptz;
  chunk_start timestamptz;
  chunk_end timestamptz;
  chunk_rows bigint;
  total_rows bigint;
BEGIN
  SELECT MIN(recorded_at), MAX(recorded_at) INTO min_time, max_time
  FROM fitness.orientation_sample;

  IF min_time IS NULL THEN
    INSERT INTO drizzle.sensor_sample_backfill_progress (
      source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
    )
    VALUES ('orientation', NULL, NULL, 0, now(), now())
    ON CONFLICT (source_name) DO UPDATE
      SET finished_at = now(), updated_at = now();
    COMMIT;
    RETURN;
  END IF;

  SELECT
    COALESCE(progress.next_cursor, min_time),
    COALESCE(progress.rows_inserted, 0)
  INTO next_cursor, total_rows
  FROM drizzle.sensor_sample_backfill_progress AS progress
  WHERE progress.source_name = 'orientation';

  IF next_cursor IS NULL OR next_cursor < min_time THEN
    next_cursor := min_time;
  END IF;
  IF total_rows IS NULL THEN
    total_rows := 0;
  END IF;

  LOOP
    SELECT sample.recorded_at
    INTO chunk_start
    FROM fitness.orientation_sample AS sample
    WHERE sample.recorded_at >= next_cursor
      AND sample.recorded_at <= max_time
    ORDER BY sample.recorded_at
    LIMIT 1;

    EXIT WHEN chunk_start IS NULL;

    chunk_end := chunk_start + batch_interval;

    INSERT INTO fitness.sensor_sample (
      recorded_at, user_id, provider_id, device_id, source_type, channel, vector
    )
    SELECT
      sample.recorded_at,
      sample.user_id,
      sample.provider_id,
      sample.device_id,
      'ble',
      'orientation',
      ARRAY[sample.quaternion_w, sample.quaternion_x, sample.quaternion_y, sample.quaternion_z]
    FROM fitness.orientation_sample AS sample
    WHERE sample.recorded_at >= chunk_start
      AND sample.recorded_at < chunk_end;

    GET DIAGNOSTICS chunk_rows = ROW_COUNT;
    total_rows := total_rows + chunk_rows;
    next_cursor := chunk_end;

    INSERT INTO drizzle.sensor_sample_backfill_progress (
      source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
    )
    VALUES ('orientation', next_cursor, max_time, total_rows, NULL, now())
    ON CONFLICT (source_name) DO UPDATE
      SET
        next_cursor = EXCLUDED.next_cursor,
        max_source_time = EXCLUDED.max_source_time,
        rows_inserted = EXCLUDED.rows_inserted,
        finished_at = NULL,
        updated_at = now();

    RAISE NOTICE 'orientation backfill: % to % -> % rows (total: %)',
      chunk_start, chunk_end, chunk_rows, total_rows;

    COMMIT;
  END LOOP;

  INSERT INTO drizzle.sensor_sample_backfill_progress (
    source_name, next_cursor, max_source_time, rows_inserted, finished_at, updated_at
  )
  VALUES ('orientation', next_cursor, max_time, total_rows, now(), now())
  ON CONFLICT (source_name) DO UPDATE
    SET
      next_cursor = EXCLUDED.next_cursor,
      max_source_time = EXCLUDED.max_source_time,
      rows_inserted = EXCLUDED.rows_inserted,
      finished_at = EXCLUDED.finished_at,
      updated_at = EXCLUDED.updated_at;

  RAISE NOTICE 'orientation backfill complete: % total sensor_sample rows', total_rows;

  COMMIT;
END;
$$;

--> statement-breakpoint

CALL drizzle.backfill_metric_stream_to_sensor_sample(INTERVAL '2 hours');

--> statement-breakpoint

CALL drizzle.backfill_imu_to_sensor_sample(INTERVAL '30 minutes');

--> statement-breakpoint

CALL drizzle.backfill_orientation_to_sensor_sample(INTERVAL '2 hours');
