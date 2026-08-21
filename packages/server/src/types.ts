// Activity router types

export type { ActivityHrZone } from "@dofek/zones/zones";
// Personalization router types
export type { PersonalizationModelCard } from "dofek/personalization/model-card";
export type { BaselineRelativeMetric } from "./contracts/baseline-relative-metrics.ts";
export type {
  MonthlyReportEmptyState,
  ReportEmptyState,
  ReportKind,
  WeeklyReportEmptyState,
} from "./contracts/report-empty-state.ts";
export type { TrainingChartAvailability } from "./contracts/training-chart-availability.ts";
export type { InsightEvidence } from "./insights/evidence.ts";
export type { ActivityDetail } from "./models/activity.ts";
export type { BehaviorAssociation } from "./repositories/behavior-impact-repository.ts";
export type { ActivityHrZones, StreamPoint } from "./routers/activity.ts";

// Recovery router types

// Sleep need router types
export type {
  SleepNeedResult,
  SleepNeedV2,
  SleepNight,
} from "./contracts/sleep-need-contract.ts";
// Climbing router types
export type {
  ClimbingGradeProgressionRow,
  ClimbingSessionSummaryRow,
  ClimbingVolumeByGradeRow,
} from "./repositories/climbing-repository.ts";
export type { ReportDecisionSynthesis } from "./repositories/report-decision-synthesis.ts";
// Training router types
export type {
  HrZoneRow,
  TrainingHrZonesResult,
} from "./repositories/training-repository.ts";
// Calendar router types
export type { CalendarDay } from "./routers/calendar.ts";
// Cycling advanced router types
export type {
  ActivityVariabilityEmptyReason,
  ActivityVariabilityResult,
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
// Health report router types
export type { HealthReportGenerateInput } from "./routers/health-report.ts";
// Healthspan router types
export type { HealthspanMetric, HealthspanResult } from "./routers/healthspan.ts";
// Hiking router types
export type {
  ActivityComparisonInstance,
  ActivityComparisonRow,
  ElevationProfileRow,
  GradeAdjustedPaceRow,
  WalkingBiomechanicsRow,
} from "./routers/hiking.ts";
// Monthly report router types
export type {
  MonthlyReportData,
  MonthlyReportResult,
  MonthSummary,
} from "./routers/monthly-report.ts";
// PMC router types
export type { PmcChartResult, PmcDataPoint, TssModelInfo } from "./routers/pmc.ts";
// Power router types
export type { CriticalPowerModel } from "./routers/power.ts";
export type {
  HrvVariabilityRow,
  ReadinessComponents,
  ReadinessRow,
  ReadinessWeights,
  SleepAnalyticsDataState,
  SleepAnalyticsResult,
  SleepConsistencyRow,
  SleepNightlyRow,
  StrainTargetResult,
  WorkloadRatioResult,
  WorkloadRatioRow,
} from "./routers/recovery.ts";
// Running router types
export type { PaceTrendRow, RunningDynamicsRow } from "./routers/running.ts";
export type { SleepPerformanceInfo } from "./routers/sleep-need.ts";
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
// Stress router types
export type {
  DailyStressRow,
  StressResult,
  WeeklyStressRow,
} from "./routers/stress.ts";
// Weekly report router types
export type {
  WeeklyReportData,
  WeeklyReportResult,
  WeekSummary,
} from "./routers/weekly-report.ts";
