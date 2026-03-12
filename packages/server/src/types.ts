// Recovery router types

// Calendar router types
export type { CalendarDay } from "./routers/calendar.ts";

// Cycling advanced router types
export type {
  ActivityVariabilityRow,
  PedalDynamicsRow,
  RampRateResult,
  RampRateWeek,
  TrainingMonotonyWeek,
  VerticalAscentRow,
} from "./routers/cycling-advanced.ts";
// Daily metrics router types
export type { HrvBaselineRow } from "./routers/daily-metrics.ts";
// Efficiency router types
export type {
  AerobicDecouplingActivity,
  AerobicEfficiencyActivity,
  AerobicEfficiencyResult,
  PolarizationTrendResult,
  PolarizationWeek,
} from "./routers/efficiency.ts";
// Hiking router types
export type {
  ActivityComparisonInstance,
  ActivityComparisonRow,
  ElevationProfileRow,
  GradeAdjustedPaceRow,
  WalkingBiomechanicsRow,
} from "./routers/hiking.ts";

// PMC router types
export type { PmcChartResult, PmcDataPoint, TssModelInfo } from "./routers/pmc.ts";

// Power router types
export type { CriticalPowerModel } from "./routers/power.ts";
export type {
  HrvVariabilityRow,
  ReadinessComponents,
  ReadinessRow,
  SleepAnalyticsResult,
  SleepNightlyRow,
  WorkloadRatioRow,
} from "./routers/recovery.ts";
// Strength router types
export type {
  EstimatedOneRepMaxEntry,
  EstimatedOneRepMaxRow,
  MuscleGroupVolumeRow,
  MuscleGroupWeek,
  ProgressiveOverloadRow,
  VolumeOverTimeRow,
  WorkoutSummaryRow,
} from "./routers/strength.ts";
