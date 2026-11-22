import { formatDateShort, formatDurationSeconds } from "./format.ts";
import type { UnitConverter } from "./units.ts";

export interface RecordedDailyMetricRow {
  date: string;
  metric: "weight" | "resting_heart_rate" | "sleep_duration_reported";
  value: number;
  unit: string | null;
  providerId: string;
  sourceName: string | null;
}

const INTERVALS_ICU_PROVIDER_ID = "intervals.icu";

/** Intervals.icu maintainers only say Garmin data may be present, so the claim is a possibility. */
export const GARMIN_INTERVALS_DISCLOSURE = "Measurements may include data from Garmin devices.";

export function recordedMetricsNeedGarminDisclosure(
  rows: readonly RecordedDailyMetricRow[],
): boolean {
  return rows.some((row) => row.providerId === INTERVALS_ICU_PROVIDER_ID);
}

/** Date-only observation text. The date is the exact local calendar day; no time is implied. */
export function formatRecordedDailyMetric(
  row: RecordedDailyMetricRow,
  units: UnitConverter,
): { date: string; label: string; value: string } {
  const date = formatDateShort(row.date, { timeZone: "UTC" });
  switch (row.metric) {
    case "weight":
      return { date, label: "Weight", value: units.formatWeight(row.value).text };
    case "resting_heart_rate":
      return { date, label: "Resting heart rate", value: units.formatHeartRate(row.value).text };
    case "sleep_duration_reported":
      return {
        date,
        label: "Reported sleep duration",
        value: formatDurationSeconds(row.value),
      };
  }
}
