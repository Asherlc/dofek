import { describe, expect, it } from "vitest";
import { METRIC_STREAM_TABLE } from "../src/metric-stream/clickhouse-table.ts";
import {
  buildMetricStreamCatchUpStatement,
  buildMetricStreamCatchUpWindows,
  parseMetricStreamCatchUpOptions,
} from "./catch-up-clickhouse-metric-stream.ts";

describe("parseMetricStreamCatchUpOptions", () => {
  it("requires explicit start and end timestamps", () => {
    expect(() => parseMetricStreamCatchUpOptions([])).toThrow("--start is required");
    expect(() => parseMetricStreamCatchUpOptions(["--start", "2026-06-05T00:00:00Z"])).toThrow(
      "--end is required",
    );
  });

  it("parses bounded dry-run options by default", () => {
    const options = parseMetricStreamCatchUpOptions([
      "--",
      "--start",
      "2026-06-05T00:00:00Z",
      "--end",
      "2026-06-05T03:00:00Z",
    ]);

    expect(options).toEqual({
      end: new Date("2026-06-05T03:00:00Z"),
      execute: false,
      maxWindows: 48,
      start: new Date("2026-06-05T00:00:00Z"),
      windowMinutes: 60,
    });
  });

  it("rejects ranges that exceed the configured window bound", () => {
    expect(() =>
      parseMetricStreamCatchUpOptions([
        "--start",
        "2026-06-05T00:00:00Z",
        "--end",
        "2026-06-05T03:00:00Z",
        "--window-minutes",
        "30",
        "--max-windows",
        "5",
      ]),
    ).toThrow("requires 6 windows, above --max-windows 5");
  });
});

describe("buildMetricStreamCatchUpWindows", () => {
  it("splits a range into half-open windows", () => {
    const windows = buildMetricStreamCatchUpWindows({
      end: new Date("2026-06-05T02:30:00Z"),
      start: new Date("2026-06-05T00:00:00Z"),
      windowMinutes: 60,
    });

    expect(windows).toEqual([
      {
        end: new Date("2026-06-05T01:00:00Z"),
        start: new Date("2026-06-05T00:00:00Z"),
      },
      {
        end: new Date("2026-06-05T02:00:00Z"),
        start: new Date("2026-06-05T01:00:00Z"),
      },
      {
        end: new Date("2026-06-05T02:30:00Z"),
        start: new Date("2026-06-05T02:00:00Z"),
      },
    ]);
  });
});

describe("buildMetricStreamCatchUpStatement", () => {
  it("builds a filtered ClickHouse insert from Postgres without IMU samples", () => {
    const sql = buildMetricStreamCatchUpStatement({
      end: new Date("2026-06-05T01:00:00Z"),
      postgresConnectionString: "postgres://health:p'ass@db:5432/health",
      start: new Date("2026-06-05T00:00:00Z"),
    });

    expect(sql).toContain(`INSERT INTO ${METRIC_STREAM_TABLE}`);
    expect(sql).toContain(
      "postgresql('db:5432', 'health', 'metric_stream', 'health', 'p\\'ass', 'fitness')",
    );
    expect(sql).toContain("LEFT ANY JOIN");
    expect(sql).toContain(`FROM ${METRIC_STREAM_TABLE} FINAL`);
    expect(sql).toContain("metric_stream.channel != 'imu'");
    expect(sql).toContain("existing_metric_stream.id IS NULL");
    expect(sql).toContain(
      "isNull(metric_stream.point) OR assumeNotNull(metric_stream.point) = '',\n    NULL,",
    );
    expect(sql).toContain("toDateTime64('2026-06-05 00:00:00.000', 6, 'UTC')");
    expect(sql).toContain("toDateTime64('2026-06-05 01:00:00.000', 6, 'UTC')");
    expect(sql).toContain("ingested_at");
    expect(sql).toContain("is_deleted");
    expect(sql).toContain("version");
  });
});
