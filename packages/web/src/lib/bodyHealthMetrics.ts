import type { FormattedMeasurement } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";

export type BodyHealthMetricEntry = {
  label: string;
  value: number | null;
  avg: number | null;
  stddev: number | null;
  unit?: string;
  formatValue?: (value: number | null | undefined) => FormattedMeasurement;
  lowerBetter?: boolean;
};

type DatedValue = { date: string };

type BodyTrendRow = {
  latest_resting_hr: number | null;
  avg_resting_hr: number | null;
  stddev_resting_hr: number | null;
};

function isInDateWindow(date: string, days: number, endDate: string): boolean {
  const end = new Date(`${endDate}T00:00:00`);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const startStr = start.toISOString().slice(0, 10);
  return date > startStr && date <= endDate;
}

function filterToWindow<T extends DatedValue>(rows: T[], days: number, endDate: string): T[] {
  return rows.filter((row) => isInDateWindow(row.date, days, endDate));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  if (avg == null) return null;
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function buildBodyHealthMetrics({
  trendData,
  weightData,
  recompData,
  days,
  endDate,
  units,
}: {
  trendData: BodyTrendRow | undefined;
  weightData: Array<{ date: string; smoothedWeight: number }>;
  recompData: Array<{ date: string; bodyFatPct: number }>;
  days: number;
  endDate: string;
  units: UnitConverter;
}): BodyHealthMetricEntry[] {
  const windowedWeight = filterToWindow(weightData, days, endDate);
  const windowedBodyFat = filterToWindow(recompData, days, endDate);
  const smoothedWeights = windowedWeight.map((row) => row.smoothedWeight);
  const bodyFatValues = windowedBodyFat.map((row) => row.bodyFatPct);

  return [
    {
      label: "Body Weight",
      value: windowedWeight.at(-1)?.smoothedWeight ?? weightData.at(-1)?.smoothedWeight ?? null,
      avg: mean(smoothedWeights),
      stddev: stddev(smoothedWeights),
      formatValue: (value) => units.formatWeight(value),
      lowerBetter: true,
    },
    {
      label: "Body Fat %",
      value: windowedBodyFat.at(-1)?.bodyFatPct ?? recompData.at(-1)?.bodyFatPct ?? null,
      avg: mean(bodyFatValues),
      stddev: stddev(bodyFatValues),
      unit: "%",
      lowerBetter: true,
    },
    {
      label: "Resting Heart Rate",
      value: trendData?.latest_resting_hr ?? null,
      avg: trendData?.avg_resting_hr ?? null,
      stddev: trendData?.stddev_resting_hr ?? null,
      unit: "bpm",
      lowerBetter: true,
    },
  ];
}
