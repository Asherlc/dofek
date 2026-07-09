export type TimeRangeDays = number | null;

export const TIME_RANGE_OPTIONS: ReadonlyArray<{ label: string; days: TimeRangeDays }> = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: null },
] as const;

export const SELECTED_RANGE_QUERY_REGISTRY = {
  behaviorImpact: ["behaviorImpact.impactSummary"],
  body: [
    "dailyMetrics.trends",
    "dailyMetrics.list",
    "dailyMetrics.hrvBaseline",
    "stress.scores",
    "bodyAnalytics.recomposition",
    "bodyAnalytics.weightOverview",
    "insights.compute",
  ],
  correlation: ["correlation.compute"],
  cycling: [
    "power.powerCurve",
    "power.eftpTrend",
    "pmc.chart",
    "efficiency.aerobicEfficiency",
    "cyclingAdvanced.activityVariability",
    "cyclingAdvanced.verticalAscentRate",
  ],
  endurance: [
    "efficiency.polarizationTrend",
    "cyclingAdvanced.rampRate",
    "cyclingAdvanced.trainingMonotony",
  ],
  hiking: [
    "hiking.gradeAdjustedPace",
    "hiking.elevationProfile",
    "hiking.walkingBiomechanics",
    "hiking.activityComparison",
  ],
  journal: ["journal.entries"],
  nutritionAnalytics: [
    "nutritionAnalytics.micronutrientAdequacy",
    "nutritionAnalytics.caloricBalance",
    "nutritionAnalytics.adaptiveTdee",
    "nutritionAnalytics.macroRatios",
  ],
  running: ["durationCurves.paceCurve", "running.paceTrend", "running.dynamics"],
  recovery: [
    "recovery.hrvVariability",
    "dailyMetrics.hrvBaseline",
    "recovery.workloadRatio",
    "recovery.sleepAnalytics",
    "recovery.readinessScore",
  ],
  sleep: ["sleep.list", "insights.compute"],
  strength: [
    "strength.volumeOverTime",
    "strength.estimatedOneRepMax",
    "strength.muscleGroupVolume",
    "strength.progressiveOverload",
  ],
  trainingOverview: ["pmc.chart", "calendar.calendarData", "insights.compute"],
  trainingInsightsPanel: ["training.weeklyVolume", "training.hrZones"],
} as const;

export function selectedRangeQueryInput(days: TimeRangeDays): { days: TimeRangeDays } {
  return { days };
}

export function minimumSelectedRangeDays(days: TimeRangeDays, minimumDays: number): TimeRangeDays {
  if (days === null) return null;
  return Math.max(days, minimumDays);
}

export function minimumSelectedRangeQueryInput(
  days: TimeRangeDays,
  minimumDays: number,
): { days: TimeRangeDays } {
  return selectedRangeQueryInput(minimumSelectedRangeDays(days, minimumDays));
}

export function fixedRangeQueryInput(days: number): { days: number } {
  return { days };
}

export function formatTimeRangeLabel(days: TimeRangeDays): string {
  return days === null ? "All" : `${days} days`;
}

export function formatTimeRangeShortLabel(days: TimeRangeDays): string {
  return days === null ? "All" : `${days}d`;
}
