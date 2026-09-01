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
    const observedDays = rows.filter((row) =>
      input.metrics.some((metric) => row.metrics[metric]?.avg != null),
    ).length;

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
        observed_days: observedDays,
        requested_days: daysBetween(input.start_date, input.end_date) + 1,
      },
    });
  }
}
