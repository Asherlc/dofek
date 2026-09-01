import {
  type HealthExplorerInput,
  type HealthExplorerSnapshot,
  type HealthMetric,
  healthExplorerSnapshotSchema,
  healthMetricPresentation,
} from "@dofek/mcp-contracts/health-explorer";

export interface HealthTrendRow {
  date?: string;
  week?: string;
  metrics: Partial<Record<HealthMetric, { avg: number }>>;
}

export interface HealthTrendReader {
  list(input: HealthExplorerInput): Promise<HealthTrendRow[]>;
}

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
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

export class HealthExplorerService {
  readonly #reader: HealthTrendReader;

  constructor(reader: HealthTrendReader) {
    this.#reader = reader;
  }

  async snapshot(
    input: HealthExplorerInput & Required<Pick<HealthExplorerInput, "timezone">>,
  ): Promise<HealthExplorerSnapshot> {
    const rows = [...(await this.#reader.list(input))].sort((first, second) =>
      rowKey(first).localeCompare(rowKey(second)),
    );
    const series = input.metrics.map((metric) => {
      const values = rows.map((row) => row.metrics[metric]?.avg ?? null);
      const observed = values.filter((value): value is number => value !== null);
      const presentation = healthMetricPresentation[metric];
      return {
        metric,
        label: presentation.label,
        unit: presentation.unit,
        points: rows.map((row, index) => ({ key: rowKey(row), value: values[index] ?? null })),
        summary: {
          metric,
          average:
            observed.length === 0
              ? null
              : observed.reduce((total, value) => total + value, 0) / observed.length,
          min: observed.length === 0 ? null : Math.min(...observed),
          max: observed.length === 0 ? null : Math.max(...observed),
        },
      };
    });
    const requestedDates = dateRange(input.start_date, input.end_date);
    const byMetric = Object.fromEntries(
      series.map(({ metric, points }) => {
        const observedDates = new Set(
          points
            .filter((point) => point.value != null && /^\d{4}-\d{2}-\d{2}$/.test(point.key))
            .map((point) => point.key),
        );
        const missingDates = requestedDates.filter((date) => !observedDates.has(date));
        return [
          metric,
          {
            observed_days: observedDates.size,
            missing_days: missingDates.slice(0, 30),
            missing_days_truncated_count: Math.max(0, missingDates.length - 30),
          },
        ];
      }),
    );

    return healthExplorerSnapshotSchema.parse({
      range: {
        start_date: input.start_date,
        end_date: input.end_date,
        granularity: input.granularity,
        timezone: input.timezone,
      },
      series: series.map(({ summary: _summary, ...item }) => item),
      summary: series.map(({ summary }) => summary),
      coverage: {
        requested_days: daysBetween(input.start_date, input.end_date) + 1,
        by_metric: byMetric,
      },
    });
  }
}
