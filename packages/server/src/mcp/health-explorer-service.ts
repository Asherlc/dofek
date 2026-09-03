import {
  type HealthExplorerInput,
  type HealthExplorerSnapshot,
  healthExplorerSnapshotSchema,
} from "@dofek/mcp-contracts/health-explorer";
import { buildHealthSeries, type HealthTrendRow } from "./health-series-service.ts";

export interface HealthTrendReader {
  list(input: HealthExplorerInput): Promise<HealthTrendRow[]>;
}

export class HealthExplorerService {
  readonly #reader: HealthTrendReader;

  constructor(reader: HealthTrendReader) {
    this.#reader = reader;
  }

  async snapshot(
    input: HealthExplorerInput & Required<Pick<HealthExplorerInput, "timezone">>,
  ): Promise<HealthExplorerSnapshot> {
    const built = buildHealthSeries(await this.#reader.list(input), input);

    return healthExplorerSnapshotSchema.parse({
      range: {
        start_date: input.start_date,
        end_date: input.end_date,
        granularity: input.granularity,
        timezone: input.timezone,
      },
      series: built.series.map(({ summary: _summary, coverage: _coverage, ...item }) => item),
      summary: built.series.map(({ metric, summary }) => ({ metric, ...summary })),
      coverage: {
        requested_days: built.requested_days,
        by_metric: Object.fromEntries(
          built.series.map(({ metric, coverage }) => [metric, coverage]),
        ),
      },
    });
  }
}
