-- ============================================================
-- Migration 0052: Backfill sensor_sample from legacy tables
-- ============================================================
-- Copies all existing data from metric_stream, inertial_measurement_unit_sample,
-- and orientation_sample into the unified sensor_sample table.
--
-- This migration processes data in weekly batches to avoid OOM on large datasets.
-- Each scalar column in metric_stream becomes a separate sensor_sample row.
-- IMU data becomes a vector channel, orientation becomes a vector channel.

-- ── 1. Backfill from metric_stream (scalar channels) ──────────

-- For each non-null scalar column, insert a row with the corresponding channel.
-- We use UNION ALL to fan out one wide row into N narrow rows.
-- Process in weekly chunks to keep memory bounded.

DO $$
DECLARE
  chunk_start timestamptz;
  chunk_end timestamptz;
  min_time timestamptz;
  max_time timestamptz;
  chunk_interval interval := '7 days';
  total_rows bigint := 0;
  chunk_rows bigint;
BEGIN
  SELECT MIN(recorded_at), MAX(recorded_at) INTO min_time, max_time
  FROM fitness.metric_stream;

  IF min_time IS NULL THEN
    RAISE NOTICE 'metric_stream is empty, skipping backfill';
    RETURN;
  END IF;

  chunk_start := min_time;

  WHILE chunk_start <= max_time LOOP
    chunk_end := chunk_start + chunk_interval;

    -- Infer source_type from provider_id:
    --   whoop_ble -> 'ble'
    --   apple_health -> 'file' (imported via XML export)
    --   everything else -> 'api'
    INSERT INTO fitness.sensor_sample (recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar)
    SELECT recorded_at, user_id, provider_id, source_name,
           CASE provider_id
             WHEN 'whoop_ble' THEN 'ble'
             WHEN 'apple_health' THEN 'file'
             ELSE 'api'
           END,
           channel, activity_id, value
    FROM (
      SELECT recorded_at, user_id, provider_id, source_name, activity_id,
             unnest(ARRAY['heart_rate','power','cadence','speed','lat','lng','altitude','temperature','grade','vertical_speed','spo2','respiratory_rate','gps_accuracy','accumulated_power','stress','left_right_balance','vertical_oscillation','stance_time','stance_time_percent','step_length','vertical_ratio','stance_time_balance','ground_contact_time','stride_length','form_power','leg_spring_stiff','air_power','left_torque_effectiveness','right_torque_effectiveness','left_pedal_smoothness','right_pedal_smoothness','combined_pedal_smoothness','blood_glucose','audio_exposure','skin_temperature','electrodermal_activity']) AS channel,
             unnest(ARRAY[heart_rate::real, power::real, cadence::real, speed, lat, lng, altitude, temperature, grade, vertical_speed, spo2, respiratory_rate, gps_accuracy::real, accumulated_power::real, stress::real, left_right_balance, vertical_oscillation, stance_time, stance_time_percent, step_length, vertical_ratio, stance_time_balance, ground_contact_time, stride_length, form_power, leg_spring_stiff, air_power, left_torque_effectiveness, right_torque_effectiveness, left_pedal_smoothness, right_pedal_smoothness, combined_pedal_smoothness, blood_glucose, audio_exposure, skin_temperature, electrodermal_activity]) AS value
      FROM fitness.metric_stream
      WHERE recorded_at >= chunk_start AND recorded_at < chunk_end
    ) expanded
    WHERE value IS NOT NULL;

    GET DIAGNOSTICS chunk_rows = ROW_COUNT;
    total_rows := total_rows + chunk_rows;
    RAISE NOTICE 'metric_stream backfill: % to % -> % rows (total: %)',
      chunk_start, chunk_end, chunk_rows, total_rows;

    chunk_start := chunk_end;
  END LOOP;

  RAISE NOTICE 'metric_stream backfill complete: % total sensor_sample rows', total_rows;
END;
$$;

--> statement-breakpoint

-- ── 2. Backfill from inertial_measurement_unit_sample (vector channel) ──

DO $$
DECLARE
  chunk_start timestamptz;
  chunk_end timestamptz;
  min_time timestamptz;
  max_time timestamptz;
  chunk_interval interval := '1 day'; -- IMU data is very dense, use 1-day chunks
  total_rows bigint := 0;
  chunk_rows bigint;
BEGIN
  SELECT MIN(recorded_at), MAX(recorded_at) INTO min_time, max_time
  FROM fitness.inertial_measurement_unit_sample;

  IF min_time IS NULL THEN
    RAISE NOTICE 'inertial_measurement_unit_sample is empty, skipping backfill';
    RETURN;
  END IF;

  chunk_start := min_time;

  WHILE chunk_start <= max_time LOOP
    chunk_end := chunk_start + chunk_interval;

    INSERT INTO fitness.sensor_sample (recorded_at, user_id, provider_id, device_id, source_type, channel, vector)
    SELECT
      recorded_at,
      user_id,
      provider_id,
      device_id,
      CASE device_type
        WHEN 'whoop' THEN 'ble'
        ELSE 'api'
      END,
      CASE
        WHEN gyroscope_x IS NOT NULL THEN 'imu'
        ELSE 'accel'
      END,
      CASE
        WHEN gyroscope_x IS NOT NULL
          THEN ARRAY[x, y, z, COALESCE(gyroscope_x, 0), COALESCE(gyroscope_y, 0), COALESCE(gyroscope_z, 0)]
        ELSE ARRAY[x, y, z]
      END
    FROM fitness.inertial_measurement_unit_sample
    WHERE recorded_at >= chunk_start AND recorded_at < chunk_end;

    GET DIAGNOSTICS chunk_rows = ROW_COUNT;
    total_rows := total_rows + chunk_rows;
    RAISE NOTICE 'IMU backfill: % to % -> % rows (total: %)',
      chunk_start, chunk_end, chunk_rows, total_rows;

    chunk_start := chunk_end;
  END LOOP;

  RAISE NOTICE 'IMU backfill complete: % total sensor_sample rows', total_rows;
END;
$$;

--> statement-breakpoint

-- ── 3. Backfill from orientation_sample (vector channel) ────

DO $$
DECLARE
  chunk_start timestamptz;
  chunk_end timestamptz;
  min_time timestamptz;
  max_time timestamptz;
  chunk_interval interval := '1 day';
  total_rows bigint := 0;
  chunk_rows bigint;
BEGIN
  SELECT MIN(recorded_at), MAX(recorded_at) INTO min_time, max_time
  FROM fitness.orientation_sample;

  IF min_time IS NULL THEN
    RAISE NOTICE 'orientation_sample is empty, skipping backfill';
    RETURN;
  END IF;

  chunk_start := min_time;

  WHILE chunk_start <= max_time LOOP
    chunk_end := chunk_start + chunk_interval;

    INSERT INTO fitness.sensor_sample (recorded_at, user_id, provider_id, device_id, source_type, channel, vector)
    SELECT
      recorded_at,
      user_id,
      provider_id,
      device_id,
      'ble', -- orientation_sample was created for WHOOP BLE
      'orientation',
      ARRAY[quaternion_w, quaternion_x, quaternion_y, quaternion_z]
    FROM fitness.orientation_sample
    WHERE recorded_at >= chunk_start AND recorded_at < chunk_end;

    GET DIAGNOSTICS chunk_rows = ROW_COUNT;
    total_rows := total_rows + chunk_rows;
    RAISE NOTICE 'orientation backfill: % to % -> % rows (total: %)',
      chunk_start, chunk_end, chunk_rows, total_rows;

    chunk_start := chunk_end;
  END LOOP;

  RAISE NOTICE 'orientation backfill complete: % total sensor_sample rows', total_rows;
END;
$$;
