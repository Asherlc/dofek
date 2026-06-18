/**
 * Sensor sample channel constants.
 *
 * Each channel name identifies a type of measurement in the metric stream.
 * Scalar channels use the `scalar` column; vector channels use `vector`.
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
/** Location point stored in the metric stream `point` field. */
export const LOCATION = "location";
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
/** R-R interval in milliseconds (beat-to-beat timing from PPG) */
export const RR_INTERVAL_MS = "rr_interval_ms";
/** Body weight in kilograms */
export const BODY_WEIGHT = "body_weight";
/** Body fat percentage */
export const BODY_FAT_PERCENTAGE = "body_fat_percentage";
/** Muscle mass in kilograms */
export const MUSCLE_MASS = "muscle_mass";
/** Bone mass in kilograms */
export const BONE_MASS = "bone_mass";
/** Body water percentage */
export const BODY_WATER_PERCENTAGE = "body_water_percentage";
/** Body Mass Index */
export const BODY_MASS_INDEX = "body_mass_index";
/** Height in centimeters */
export const HEIGHT = "height";
/** Waist circumference in centimeters */
export const WAIST_CIRCUMFERENCE = "waist_circumference";
/** Systolic blood pressure in mmHg */
export const SYSTOLIC_BLOOD_PRESSURE = "systolic_blood_pressure";
/** Diastolic blood pressure in mmHg */
export const DIASTOLIC_BLOOD_PRESSURE = "diastolic_blood_pressure";
/** Pulse associated with a body measurement in bpm */
export const HEART_PULSE = "heart_pulse";
/** Body temperature in celsius */
export const BODY_TEMPERATURE = "body_temperature";

// ── Source types (informational, not used for dedup priority) ─

export const SOURCE_TYPE_FILE = "file" as const;
export const SOURCE_TYPE_API = "api" as const;

/**
 * Mapping from Drizzle camelCase field names to metric stream channel names.
 * Used when converting Drizzle insert objects (e.g., from fitRecordsToMetricStream).
 */
export const DRIZZLE_FIELD_TO_CHANNEL: Record<string, string> = {
  heartRate: HEART_RATE,
  power: POWER,
  cadence: CADENCE,
  speed: SPEED,
  altitude: ALTITUDE,
  temperature: TEMPERATURE,
  grade: GRADE,
  verticalSpeed: VERTICAL_SPEED,
  spo2: SPO2,
  respiratoryRate: RESPIRATORY_RATE,
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
  weightKg: BODY_WEIGHT,
  bodyFatPct: BODY_FAT_PERCENTAGE,
  muscleMassKg: MUSCLE_MASS,
  boneMassKg: BONE_MASS,
  waterPct: BODY_WATER_PERCENTAGE,
  bmi: BODY_MASS_INDEX,
  heightCm: HEIGHT,
  waistCircumferenceCm: WAIST_CIRCUMFERENCE,
  systolicBp: SYSTOLIC_BLOOD_PRESSURE,
  diastolicBp: DIASTOLIC_BLOOD_PRESSURE,
  heartPulse: HEART_PULSE,
  temperatureC: BODY_TEMPERATURE,
};

export const BODY_MEASUREMENT_COLUMN_TO_CHANNEL: Record<string, string> = {
  weight_kg: BODY_WEIGHT,
  body_fat_pct: BODY_FAT_PERCENTAGE,
  muscle_mass_kg: MUSCLE_MASS,
  bone_mass_kg: BONE_MASS,
  water_pct: BODY_WATER_PERCENTAGE,
  bmi: BODY_MASS_INDEX,
  height_cm: HEIGHT,
  waist_circumference_cm: WAIST_CIRCUMFERENCE,
  systolic_bp: SYSTOLIC_BLOOD_PRESSURE,
  diastolic_bp: DIASTOLIC_BLOOD_PRESSURE,
  heart_pulse: HEART_PULSE,
  temperature_c: BODY_TEMPERATURE,
};
