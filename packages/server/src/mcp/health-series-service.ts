import {
  type HealthExplorerInput,
  type HealthMetric,
  healthMetricPresentation,
} from "@dofek/mcp-contracts/health-explorer";

export interface HealthTrendRow {
  date?: string;
  week?: string;
  metrics: Partial<
    Record<HealthMetric, { avg: number; baseline_relative?: unknown; observed_dates?: string[] }>
  >;
}

export interface MetricCoverage {
  observed_days: number;
  missing_days: string[];
  missing_days_truncated_count: number;
}

export interface BuiltHealthSeries {
  requested_days: number;
  series: Array<{
    metric: HealthMetric;
    label: string;
    unit: string;
    points: Array<{ key: string; value: number | null; baseline_relative: unknown | null }>;
    note: "no_data_in_range" | null;
    summary: { average: number | null; min: number | null; max: number | null };
    coverage: MetricCoverage;
  }>;
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function rowKey(row: HealthTrendRow): string {
  const key = row.date ?? row.week;
  if (!key) {
    throw new Error("Health trend row must have a date or week key");
  }
  return key;
}

/** Build canonical nullable, coverage-aware metric series for all MCP health consumers. */
export function buildHealthSeries(
  inputRows: HealthTrendRow[],
  input: HealthExplorerInput,
): BuiltHealthSeries {
  const rows = [...inputRows].sort((first, second) => rowKey(first).localeCompare(rowKey(second)));
  const requestedDates = dateRange(input.start_date, input.end_date);
  const requestedDateSet = new Set(requestedDates);
  const rowsByDate = new Map(rows.flatMap((row) => (row.date ? [[row.date, row] as const] : [])));

  const series = input.metrics.map((metric) => {
    const presentation = healthMetricPresentation[metric];
    const candidatePoints =
      input.granularity === "daily"
        ? requestedDates.map((date) => ({
            key: date,
            value: rowsByDate.get(date)?.metrics[metric]?.avg ?? null,
            baseline_relative: rowsByDate.get(date)?.metrics[metric]?.baseline_relative ?? null,
          }))
        : rows.map((row) => ({
            key: rowKey(row),
            value: row.metrics[metric]?.avg ?? null,
            baseline_relative: row.metrics[metric]?.baseline_relative ?? null,
          }));
    const observed = candidatePoints.flatMap((point) =>
      point.value == null ? [] : [{ key: point.key, value: point.value }],
    );
    const observedDateSet = new Set(
      rows.flatMap((row) =>
        (
          row.metrics[metric]?.observed_dates ??
          (row.date && row.metrics[metric]?.avg != null ? [row.date] : [])
        ).filter((date) => requestedDateSet.has(date)),
      ),
    );
    const missingDates = requestedDates.filter((date) => !observedDateSet.has(date));
    const values = observed.map((point) => point.value);
    return {
      metric,
      label: presentation.label,
      unit: presentation.unit,
      points: observed.length === 0 ? [] : candidatePoints,
      note: observed.length === 0 ? ("no_data_in_range" as const) : null,
      summary: {
        average:
          values.length === 0
            ? null
            : values.reduce((total, value) => total + value, 0) / values.length,
        min: values.length === 0 ? null : Math.min(...values),
        max: values.length === 0 ? null : Math.max(...values),
      },
      coverage: {
        observed_days: observedDateSet.size,
        missing_days: missingDates.slice(0, 30),
        missing_days_truncated_count: Math.max(0, missingDates.length - 30),
      },
    };
  });

  return { requested_days: requestedDates.length, series };
}
