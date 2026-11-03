/**
 * Performance Management Chart (PMC) domain logic.
 *
 * Pure TRIMP calculation and power-based performance-management contracts. No database or infrastructure dependencies.
 * Shared between web and iOS via @dofek/training.
 */

export interface PmcDataPoint {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export interface TssModelInfo {
  ftp: number | null;
}

export interface PmcChartResult {
  data: PmcDataPoint[];
  model: TssModelInfo;
}

/**
 * Compute Bannister TRIMP for an activity.
 *
 * TRIMP = duration_minutes * deltaHR_ratio * genderFactor * e^(exponent * deltaHR_ratio)
 *   where deltaHR_ratio = (avg_hr - resting_hr) / (max_hr - resting_hr)
 *
 * genderFactor and exponent default to 0.64 and 1.92 (Bannister generic)
 * but can be personalized per user.
 */
export function computeTrimp(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
  genderFactor = 0.64,
  exponent = 1.92,
): number {
  if (maxHr <= restingHr || durationMin <= 0) return 0;
  const deltaHrRatio = (avgHr - restingHr) / (maxHr - restingHr);
  if (deltaHrRatio <= 0) return 0;
  return durationMin * deltaHrRatio * genderFactor * Math.exp(exponent * deltaHrRatio);
}
