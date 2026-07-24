// ============================================================
// Types
// ============================================================

export interface ParsedFitSession {
  sport: string;
  subSport?: string;
  startTime: Date;
  totalElapsedTime: number;
  totalTimerTime: number;
  totalDistance: number;
  totalAscent?: number;
  totalDescent?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  maxCadence?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  normalizedPower?: number;
  tss?: number;
  intensityFactor?: number;
  thresholdPower?: number;
  avgTemperature?: number;
  maxTemperature?: number;
  minTemperature?: number;
  totalWork?: number;
  trainingEffect?: number;
  anaerobicTrainingEffect?: number;
  avgLeftTorqueEffectiveness?: number;
  avgLeftPedalSmoothness?: number;
  raw: Record<string, unknown>;
}

export interface ParsedFitRecord {
  recordedAt: Date;
  // Core sensor data
  heartRate?: number;
  power?: number;
  cadence?: number;
  speed?: number;
  lat?: number;
  lng?: number;
  altitude?: number;
  temperature?: number;
  distance?: number;
  grade?: number;
  verticalSpeed?: number;
  gpsAccuracy?: number;
  accumulatedPower?: number;
  // Power balance / pedaling
  leftRightBalance?: number;
  leftTorqueEffectiveness?: number;
  rightTorqueEffectiveness?: number;
  leftPedalSmoothness?: number;
  rightPedalSmoothness?: number;
  combinedPedalSmoothness?: number;
  // Running dynamics
  verticalOscillation?: number;
  stanceTime?: number;
  stanceTimePercent?: number;
  stepLength?: number;
  verticalRatio?: number;
  stanceTimeBalance?: number;
  // Complete raw record — every field, no data loss
  raw: Record<string, unknown>;
}

// ============================================================
// Record parsing — pure function
// ============================================================

function num(val: unknown): number | undefined {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return undefined;
}

function intOrUndef(val: unknown): number | undefined {
  const numericValue = num(val);
  return numericValue !== undefined ? Math.round(numericValue) : undefined;
}

function extractLeftRightBalance(val: unknown): number | undefined {
  if (typeof val === "object" && val !== null && "value" in val) {
    return num(val.value);
  }
  return num(val);
}

export function parseFitRecord(raw: Record<string, unknown>): ParsedFitRecord {
  return {
    recordedAt: new Date(String(raw.timestamp)),
    heartRate: intOrUndef(raw.heart_rate),
    power: intOrUndef(raw.power),
    cadence: intOrUndef(raw.cadence),
    speed: num(raw.enhanced_speed) ?? num(raw.speed),
    lat: num(raw.position_lat),
    lng: num(raw.position_long),
    altitude: num(raw.enhanced_altitude) ?? num(raw.altitude),
    temperature: num(raw.temperature),
    distance: num(raw.distance),
    grade: num(raw.grade),
    verticalSpeed: num(raw.vertical_speed),
    gpsAccuracy: intOrUndef(raw.gps_accuracy),
    accumulatedPower: intOrUndef(raw.accumulated_power),
    leftRightBalance: extractLeftRightBalance(raw.left_right_balance),
    leftTorqueEffectiveness: num(raw.left_torque_effectiveness),
    rightTorqueEffectiveness: num(raw.right_torque_effectiveness),
    leftPedalSmoothness: num(raw.left_pedal_smoothness),
    rightPedalSmoothness: num(raw.right_pedal_smoothness),
    combinedPedalSmoothness: num(raw.combined_pedal_smoothness),
    verticalOscillation: num(raw.vertical_oscillation),
    stanceTime: num(raw.stance_time),
    stanceTimePercent: num(raw.stance_time_percent),
    stepLength: num(raw.step_length),
    verticalRatio: num(raw.vertical_ratio),
    stanceTimeBalance: num(raw.stance_time_balance),
    raw,
  };
}

// ============================================================
// Session parsing
// ============================================================

export function parseFitSession(raw: Record<string, unknown>): ParsedFitSession {
  return {
    sport: typeof raw.sport === "string" ? raw.sport : "unknown",
    subSport: typeof raw.sub_sport === "string" ? raw.sub_sport : undefined,
    startTime: new Date(String(raw.start_time)),
    totalElapsedTime: num(raw.total_elapsed_time) ?? 0,
    totalTimerTime: num(raw.total_timer_time) ?? 0,
    totalDistance: num(raw.total_distance) ?? 0,
    totalAscent: intOrUndef(raw.total_ascent),
    totalDescent: intOrUndef(raw.total_descent),
    avgHeartRate: intOrUndef(raw.avg_heart_rate),
    maxHeartRate: intOrUndef(raw.max_heart_rate),
    avgPower: intOrUndef(raw.avg_power),
    maxPower: intOrUndef(raw.max_power),
    avgCadence: intOrUndef(raw.avg_cadence),
    maxCadence: intOrUndef(raw.max_cadence),
    avgSpeed: num(raw.enhanced_avg_speed) ?? num(raw.avg_speed),
    maxSpeed: num(raw.enhanced_max_speed) ?? num(raw.max_speed),
    normalizedPower: intOrUndef(raw.normalized_power),
    tss: num(raw.training_stress_score),
    intensityFactor: num(raw.intensity_factor),
    thresholdPower: intOrUndef(raw.threshold_power),
    avgTemperature: intOrUndef(raw.avg_temperature),
    maxTemperature: intOrUndef(raw.max_temperature),
    minTemperature: intOrUndef(raw.min_temperature),
    totalWork: intOrUndef(raw.total_work),
    trainingEffect: num(raw.total_training_effect),
    anaerobicTrainingEffect: num(raw.total_anaerobic_training_effect),
    avgLeftTorqueEffectiveness: num(raw.avg_left_torque_effectiveness),
    avgLeftPedalSmoothness: num(raw.avg_left_pedal_smoothness),
    raw,
  };
}
