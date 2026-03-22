/** Per-provider record counts across all data types. */
export interface ProviderStats {
  activities: number;
  dailyMetrics: number;
  sleepSessions: number;
  bodyMeasurements: number;
  foodEntries: number;
  healthEvents: number;
  metricStream: number;
  nutritionDaily: number;
  labResults: number;
  journalEntries: number;
}

/** Ordered mapping of stat keys to human-readable labels, used for display. */
export const DATA_TYPE_LABELS: ReadonlyArray<{
  key: keyof ProviderStats;
  label: string;
}> = [
  { key: "activities", label: "Activities" },
  { key: "metricStream", label: "Metric Stream" },
  { key: "dailyMetrics", label: "Daily Metrics" },
  { key: "sleepSessions", label: "Sleep" },
  { key: "bodyMeasurements", label: "Body" },
  { key: "foodEntries", label: "Food" },
  { key: "nutritionDaily", label: "Nutrition" },
  { key: "healthEvents", label: "Events" },
  { key: "labResults", label: "Lab Results" },
  { key: "journalEntries", label: "Journal" },
] as const;

/** Sum of all record counts for a provider. */
export function providerStatsTotal(stats: ProviderStats): number {
  let total = 0;
  for (const { key } of DATA_TYPE_LABELS) {
    total += stats[key];
  }
  return total;
}

/** Non-zero stat entries with labels, in display order. */
export function providerStatsBreakdown(
  stats: ProviderStats,
): Array<{ label: string; count: number }> {
  const result: Array<{ label: string; count: number }> = [];
  for (const { key, label } of DATA_TYPE_LABELS) {
    const count = stats[key];
    if (count > 0) {
      result.push({ label, count });
    }
  }
  return result;
}
