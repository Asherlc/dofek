-- Pivot view that presents sensor_sample data in the same wide-row format
-- as the legacy metric_stream table. Includes built-in dedup: for each
-- (activity_id, channel), picks the provider_id with the most samples.
--
-- This view exists as a migration aid — repositories can switch from
-- "fitness.metric_stream" to "fitness.v_metric_stream" with minimal
-- query changes. Once all queries are migrated to read sensor_sample
-- directly, this view can be dropped.

CREATE MATERIALIZED VIEW fitness.v_metric_stream AS
WITH best_source AS (
  SELECT DISTINCT ON (activity_id, channel)
    activity_id, channel, provider_id
  FROM (
    SELECT activity_id, channel, provider_id, COUNT(*) AS sample_count
    FROM fitness.sensor_sample
    WHERE activity_id IS NOT NULL
      AND scalar IS NOT NULL
    GROUP BY activity_id, channel, provider_id
  ) counts
  ORDER BY activity_id, channel, sample_count DESC
),
deduped AS (
  SELECT ss.recorded_at, ss.user_id, ss.activity_id, ss.provider_id,
         ss.device_id, ss.channel, ss.scalar
  FROM fitness.sensor_sample ss
  JOIN best_source bs
    ON ss.activity_id = bs.activity_id
    AND ss.channel = bs.channel
    AND ss.provider_id = bs.provider_id
  WHERE ss.activity_id IS NOT NULL
    AND ss.scalar IS NOT NULL
)
SELECT
  recorded_at,
  user_id,
  activity_id,
  -- Pivot channels back to wide columns matching metric_stream shape
  MAX(scalar) FILTER (WHERE channel = 'heart_rate')::SMALLINT AS heart_rate,
  MAX(scalar) FILTER (WHERE channel = 'power')::SMALLINT AS power,
  MAX(scalar) FILTER (WHERE channel = 'cadence')::SMALLINT AS cadence,
  MAX(scalar) FILTER (WHERE channel = 'speed') AS speed,
  MAX(scalar) FILTER (WHERE channel = 'lat') AS lat,
  MAX(scalar) FILTER (WHERE channel = 'lng') AS lng,
  MAX(scalar) FILTER (WHERE channel = 'altitude') AS altitude,
  MAX(scalar) FILTER (WHERE channel = 'temperature') AS temperature,
  MAX(scalar) FILTER (WHERE channel = 'grade') AS grade,
  MAX(scalar) FILTER (WHERE channel = 'vertical_speed') AS vertical_speed,
  MAX(scalar) FILTER (WHERE channel = 'spo2') AS spo2,
  MAX(scalar) FILTER (WHERE channel = 'respiratory_rate') AS respiratory_rate,
  MAX(scalar) FILTER (WHERE channel = 'gps_accuracy')::SMALLINT AS gps_accuracy,
  MAX(scalar) FILTER (WHERE channel = 'accumulated_power')::INT AS accumulated_power,
  MAX(scalar) FILTER (WHERE channel = 'stress')::SMALLINT AS stress,
  MAX(scalar) FILTER (WHERE channel = 'left_right_balance') AS left_right_balance,
  MAX(scalar) FILTER (WHERE channel = 'vertical_oscillation') AS vertical_oscillation,
  MAX(scalar) FILTER (WHERE channel = 'stance_time') AS stance_time,
  MAX(scalar) FILTER (WHERE channel = 'stance_time_percent') AS stance_time_percent,
  MAX(scalar) FILTER (WHERE channel = 'step_length') AS step_length,
  MAX(scalar) FILTER (WHERE channel = 'vertical_ratio') AS vertical_ratio,
  MAX(scalar) FILTER (WHERE channel = 'stance_time_balance') AS stance_time_balance,
  MAX(scalar) FILTER (WHERE channel = 'ground_contact_time') AS ground_contact_time,
  MAX(scalar) FILTER (WHERE channel = 'stride_length') AS stride_length,
  MAX(scalar) FILTER (WHERE channel = 'form_power') AS form_power,
  MAX(scalar) FILTER (WHERE channel = 'leg_spring_stiff') AS leg_spring_stiff,
  MAX(scalar) FILTER (WHERE channel = 'air_power') AS air_power,
  MAX(scalar) FILTER (WHERE channel = 'left_torque_effectiveness') AS left_torque_effectiveness,
  MAX(scalar) FILTER (WHERE channel = 'right_torque_effectiveness') AS right_torque_effectiveness,
  MAX(scalar) FILTER (WHERE channel = 'left_pedal_smoothness') AS left_pedal_smoothness,
  MAX(scalar) FILTER (WHERE channel = 'right_pedal_smoothness') AS right_pedal_smoothness,
  MAX(scalar) FILTER (WHERE channel = 'combined_pedal_smoothness') AS combined_pedal_smoothness,
  MAX(scalar) FILTER (WHERE channel = 'blood_glucose') AS blood_glucose,
  MAX(scalar) FILTER (WHERE channel = 'audio_exposure') AS audio_exposure,
  MAX(scalar) FILTER (WHERE channel = 'skin_temperature') AS skin_temperature,
  MAX(scalar) FILTER (WHERE channel = 'electrodermal_activity') AS electrodermal_activity,
  MAX(device_id) AS source_name
FROM deduped
GROUP BY recorded_at, user_id, activity_id;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS v_metric_stream_activity_time_idx
  ON fitness.v_metric_stream (activity_id, recorded_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS v_metric_stream_user_time_idx
  ON fitness.v_metric_stream (user_id, recorded_at);
