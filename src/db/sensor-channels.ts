/**
 * Sensor sample channel constants.
 *
 * Each channel name identifies a type of measurement stored in the
 * sensor_sample table. Scalar channels use the `scalar` column;
 * vector channels use the `vector` (real[]) column.
 */

// ── Scalar channels (single numeric value) ──────────────────

/** Heart rate in bpm */
export const HEART_RATE = "heart_rate";
/** Power in watts */
export const POWER = "power";
/** Cadence in rpm */
export const CADENCE = "cadence";
/** Speed in m/s */
export const SPEED = "speed";
/** Latitude in degrees */
export const LAT = "lat";
/** Longitude in degrees */
export const LNG = "lng";
/** Altitude in meters */
export const ALTITUDE = "altitude";
/** Temperature in celsius */
export const TEMPERATURE = "temperature";
/** Grade in percent */
export const GRADE = "grade";
/** Vertical speed in m/s */
export const VERTICAL_SPEED = "vertical_speed";
/** SpO2 as fraction (0-1) */
export const SPO2 = "spo2";
/** Respiratory rate in breaths/min */
export const RESPIRATORY_RATE = "respiratory_rate";
/** GPS accuracy in meters */
export const GPS_ACCURACY = "gps_accuracy";
/** Cumulative power in watts */
export const ACCUMULATED_POWER = "accumulated_power";
/** Stress score */
export const STRESS = "stress";
/** Left/right power balance in percent */
export const LEFT_RIGHT_BALANCE = "left_right_balance";
/** Vertical oscillation in mm (running) */
export const VERTICAL_OSCILLATION = "vertical_oscillation";
/** Stance time in ms (running) */
export const STANCE_TIME = "stance_time";
/** Stance time percent (running) */
export const STANCE_TIME_PERCENT = "stance_time_percent";
/** Step length in mm (running) */
export const STEP_LENGTH = "step_length";
/** Vertical ratio in percent (running) */
export const VERTICAL_RATIO = "vertical_ratio";
/** Stance time balance in percent (running) */
export const STANCE_TIME_BALANCE = "stance_time_balance";
/** Ground contact time in ms */
export const GROUND_CONTACT_TIME = "ground_contact_time";
/** Stride length in meters */
export const STRIDE_LENGTH = "stride_length";
/** Form power in watts (running) */
export const FORM_POWER = "form_power";
/** Leg spring stiffness */
export const LEG_SPRING_STIFF = "leg_spring_stiff";
/** Air power in watts */
export const AIR_POWER = "air_power";
/** Left torque effectiveness in percent */
export const LEFT_TORQUE_EFFECTIVENESS = "left_torque_effectiveness";
/** Right torque effectiveness in percent */
export const RIGHT_TORQUE_EFFECTIVENESS = "right_torque_effectiveness";
/** Left pedal smoothness in percent */
export const LEFT_PEDAL_SMOOTHNESS = "left_pedal_smoothness";
/** Right pedal smoothness in percent */
export const RIGHT_PEDAL_SMOOTHNESS = "right_pedal_smoothness";
/** Combined pedal smoothness in percent */
export const COMBINED_PEDAL_SMOOTHNESS = "combined_pedal_smoothness";
/** Blood glucose in mmol/L */
export const BLOOD_GLUCOSE = "blood_glucose";
/** Audio exposure in dBASPL */
export const AUDIO_EXPOSURE = "audio_exposure";
/** Skin temperature in celsius */
export const SKIN_TEMPERATURE = "skin_temperature";
/** Electrodermal activity in microsiemens */
export const ELECTRODERMAL_ACTIVITY = "electrodermal_activity";

// ── Vector channels (multi-axis data as real[]) ─────────────

/** Accelerometer [x, y, z] in g — accel-only sources */
export const ACCEL = "accel";
/** 6-axis IMU [x, y, z, gyroscope_x, gyroscope_y, gyroscope_z] — accel in g, gyro in rad/s */
export const IMU = "imu";
/** Orientation quaternion [w, x, y, z] */
export const ORIENTATION = "orientation";

// ── Source types (informational, not used for dedup priority) ─

export const SOURCE_TYPE_BLE = "ble";
export const SOURCE_TYPE_FILE = "file";
export const SOURCE_TYPE_API = "api";

/**
 * Mapping from legacy metric_stream column names to sensor_sample channel names.
 * Used during the migration period to convert wide-row inserts to per-channel rows.
 */
export const METRIC_STREAM_COLUMN_TO_CHANNEL: Record<string, string> = {
  heart_rate: HEART_RATE,
  power: POWER,
  cadence: CADENCE,
  speed: SPEED,
  lat: LAT,
  lng: LNG,
  altitude: ALTITUDE,
  temperature: TEMPERATURE,
  grade: GRADE,
  vertical_speed: VERTICAL_SPEED,
  spo2: SPO2,
  respiratory_rate: RESPIRATORY_RATE,
  gps_accuracy: GPS_ACCURACY,
  accumulated_power: ACCUMULATED_POWER,
  stress: STRESS,
  left_right_balance: LEFT_RIGHT_BALANCE,
  vertical_oscillation: VERTICAL_OSCILLATION,
  stance_time: STANCE_TIME,
  stance_time_percent: STANCE_TIME_PERCENT,
  step_length: STEP_LENGTH,
  vertical_ratio: VERTICAL_RATIO,
  stance_time_balance: STANCE_TIME_BALANCE,
  ground_contact_time: GROUND_CONTACT_TIME,
  stride_length: STRIDE_LENGTH,
  form_power: FORM_POWER,
  leg_spring_stiff: LEG_SPRING_STIFF,
  air_power: AIR_POWER,
  left_torque_effectiveness: LEFT_TORQUE_EFFECTIVENESS,
  right_torque_effectiveness: RIGHT_TORQUE_EFFECTIVENESS,
  left_pedal_smoothness: LEFT_PEDAL_SMOOTHNESS,
  right_pedal_smoothness: RIGHT_PEDAL_SMOOTHNESS,
  combined_pedal_smoothness: COMBINED_PEDAL_SMOOTHNESS,
  blood_glucose: BLOOD_GLUCOSE,
  audio_exposure: AUDIO_EXPOSURE,
  skin_temperature: SKIN_TEMPERATURE,
  electrodermal_activity: ELECTRODERMAL_ACTIVITY,
};

/** All scalar channel names (for validation / iteration) */
export const SCALAR_CHANNELS = Object.values(METRIC_STREAM_COLUMN_TO_CHANNEL);

/** All vector channel names */
export const VECTOR_CHANNELS = [ACCEL, IMU, ORIENTATION] as const;

/**
 * Mapping from Drizzle camelCase field names to sensor_sample channel names.
 * Used when converting Drizzle insert objects (e.g., from fitRecordsToMetricStream).
 */
export const DRIZZLE_FIELD_TO_CHANNEL: Record<string, string> = {
  heartRate: HEART_RATE,
  power: POWER,
  cadence: CADENCE,
  speed: SPEED,
  lat: LAT,
  lng: LNG,
  altitude: ALTITUDE,
  temperature: TEMPERATURE,
  grade: GRADE,
  verticalSpeed: VERTICAL_SPEED,
  spo2: SPO2,
  respiratoryRate: RESPIRATORY_RATE,
  gpsAccuracy: GPS_ACCURACY,
  accumulatedPower: ACCUMULATED_POWER,
  stress: STRESS,
  leftRightBalance: LEFT_RIGHT_BALANCE,
  verticalOscillation: VERTICAL_OSCILLATION,
  stanceTime: STANCE_TIME,
  stanceTimePercent: STANCE_TIME_PERCENT,
  stepLength: STEP_LENGTH,
  verticalRatio: VERTICAL_RATIO,
  stanceTimeBalance: STANCE_TIME_BALANCE,
  groundContactTime: GROUND_CONTACT_TIME,
  strideLength: STRIDE_LENGTH,
  formPower: FORM_POWER,
  legSpringStiff: LEG_SPRING_STIFF,
  airPower: AIR_POWER,
  leftTorqueEffectiveness: LEFT_TORQUE_EFFECTIVENESS,
  rightTorqueEffectiveness: RIGHT_TORQUE_EFFECTIVENESS,
  leftPedalSmoothness: LEFT_PEDAL_SMOOTHNESS,
  rightPedalSmoothness: RIGHT_PEDAL_SMOOTHNESS,
  combinedPedalSmoothness: COMBINED_PEDAL_SMOOTHNESS,
  bloodGlucose: BLOOD_GLUCOSE,
  audioExposure: AUDIO_EXPOSURE,
  skinTemperature: SKIN_TEMPERATURE,
  electrodermalActivity: ELECTRODERMAL_ACTIVITY,
};
