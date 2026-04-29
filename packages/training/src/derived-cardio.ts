export interface CyclingVo2MaxInput {
  fiveMinutePowerWatts: number;
  weightKg: number | null;
}

export interface AcsmVo2MaxInput {
  speedMetersPerMinute: number;
  gradeFraction: number;
  averageHeartRate: number;
  restingHeartRate: number;
  maxHeartRate: number;
}

const MIN_CYCLING_POWER_WATTS = 50;
const MAX_CYCLING_POWER_WATTS = 700;
const CYCLING_POWER_TO_OXYGEN_FACTOR = 10.8;
const CYCLING_RESTING_OXYGEN_COST = 7;

const MIN_ACSM_SPEED_METERS_PER_MINUTE = 40;
const MAX_ACSM_SPEED_METERS_PER_MINUTE = 450;
const MIN_ACSM_GRADE = -0.15;
const MAX_ACSM_GRADE = 0.15;
const RUNNING_SPEED_THRESHOLD_METERS_PER_MINUTE = 134;
const MIN_HEART_RATE_RESERVE_FRACTION = 0.6;
const MAX_HEART_RATE_RESERVE_FRACTION = 1;

const SUPPORTED_OUTDOOR_VO2_MAX_ACTIVITY_TYPES = [
  "running",
  "trail_running",
  "walking",
  "hiking",
] as const;

export function estimateCyclingVo2Max(input: CyclingVo2MaxInput): number | null {
  if (!Number.isFinite(input.fiveMinutePowerWatts)) {
    return null;
  }

  if (input.weightKg === null || !Number.isFinite(input.weightKg) || input.weightKg <= 0) {
    return null;
  }

  if (
    input.fiveMinutePowerWatts < MIN_CYCLING_POWER_WATTS ||
    input.fiveMinutePowerWatts > MAX_CYCLING_POWER_WATTS
  ) {
    return null;
  }

  return (
    (input.fiveMinutePowerWatts / input.weightKg) * CYCLING_POWER_TO_OXYGEN_FACTOR +
    CYCLING_RESTING_OXYGEN_COST
  );
}

export function estimateSubmaximalAcsmVo2Max(input: AcsmVo2MaxInput): number | null {
  if (
    !Number.isFinite(input.speedMetersPerMinute) ||
    !Number.isFinite(input.gradeFraction) ||
    !Number.isFinite(input.averageHeartRate) ||
    !Number.isFinite(input.restingHeartRate) ||
    !Number.isFinite(input.maxHeartRate)
  ) {
    return null;
  }

  if (
    input.speedMetersPerMinute < MIN_ACSM_SPEED_METERS_PER_MINUTE ||
    input.speedMetersPerMinute > MAX_ACSM_SPEED_METERS_PER_MINUTE
  ) {
    return null;
  }

  if (input.gradeFraction < MIN_ACSM_GRADE || input.gradeFraction > MAX_ACSM_GRADE) {
    return null;
  }

  const heartRateReserve = input.maxHeartRate - input.restingHeartRate;

  if (heartRateReserve <= 0) {
    return null;
  }

  const intensityFraction = (input.averageHeartRate - input.restingHeartRate) / heartRateReserve;

  if (
    intensityFraction < MIN_HEART_RATE_RESERVE_FRACTION ||
    intensityFraction >= MAX_HEART_RATE_RESERVE_FRACTION
  ) {
    return null;
  }

  const oxygenCost =
    input.speedMetersPerMinute >= RUNNING_SPEED_THRESHOLD_METERS_PER_MINUTE
      ? getRunningOxygenCost(input.speedMetersPerMinute, input.gradeFraction)
      : getWalkingOxygenCost(input.speedMetersPerMinute, input.gradeFraction);

  return oxygenCost / intensityFraction;
}

export function averageVo2MaxEstimates(estimates: readonly (number | null)[]): number | null {
  const validEstimates = estimates.filter(
    (estimate): estimate is number => estimate !== null && Number.isFinite(estimate),
  );

  if (validEstimates.length === 0) {
    return null;
  }

  const totalEstimate = validEstimates.reduce(
    (runningTotal, estimate) => runningTotal + estimate,
    0,
  );

  return totalEstimate / validEstimates.length;
}

export function isSupportedOutdoorVo2MaxActivityType(activityType: string): boolean {
  return SUPPORTED_OUTDOOR_VO2_MAX_ACTIVITY_TYPES.some(
    (supportedActivityType) => supportedActivityType === activityType,
  );
}

function getWalkingOxygenCost(speedMetersPerMinute: number, gradeFraction: number): number {
  return 0.1 * speedMetersPerMinute + 1.8 * speedMetersPerMinute * gradeFraction + 3.5;
}

function getRunningOxygenCost(speedMetersPerMinute: number, gradeFraction: number): number {
  return 0.2 * speedMetersPerMinute + 0.9 * speedMetersPerMinute * gradeFraction + 3.5;
}
