import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillMissingBodyMeasurementSamples,
  countMissingBodyMeasurementSamples,
} from "../src/db/body-measurement-sample.ts";
import type { ClickHouseClient } from "../src/db/clickhouse.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import {
  main,
  parseBodyMeasurementSampleBackfillOptions,
} from "./backfill-body-measurement-sample.ts";

vi.mock("../src/lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  close: vi.fn(async () => true),
  init: vi.fn(),
}));

vi.mock("../src/db/body-measurement-sample.ts", () => ({
  backfillMissingBodyMeasurementSamples: vi.fn(),
  countMissingBodyMeasurementSamples: vi.fn(),
}));

vi.mock("../src/db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("parseBodyMeasurementSampleBackfillOptions", () => {
  it("requires an explicit bounded range and defaults to a dry run", () => {
    const options = parseBodyMeasurementSampleBackfillOptions([
      "--start",
      "2026-06-21T00:00:00Z",
      "--end",
      "2026-07-21T00:00:00Z",
    ]);

    expect(options).toEqual({
      start: new Date("2026-06-21T00:00:00Z"),
      end: new Date("2026-07-21T00:00:00Z"),
      execute: false,
    });
  });

  it("enables writes only with --execute", () => {
    expect(
      parseBodyMeasurementSampleBackfillOptions([
        "--start",
        "2026-06-21",
        "--end",
        "2026-07-21",
        "--execute",
      ]).execute,
    ).toBe(true);
  });

  it.each([
    { args: [], message: "--start is required" },
    { args: ["--start", "2026-06-21"], message: "--end is required" },
    {
      args: ["--start", "2026-07-21", "--end", "2026-06-21"],
      message: "--start must be before --end",
    },
  ])("rejects invalid bounds", ({ args, message }) => {
    expect(() => parseBodyMeasurementSampleBackfillOptions(args)).toThrow(message);
  });
});

describe("main", () => {
  it("executes the backfill without a separate count query", async () => {
    const client: ClickHouseClient = {
      close: vi.fn(async () => undefined),
      command: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [] })),
    };
    vi.mocked(createClickHouseClientFromEnv).mockReturnValue(client);
    vi.mocked(backfillMissingBodyMeasurementSamples).mockResolvedValue(12);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["--start", "2026-06-21T00:00:00Z", "--end", "2026-07-21T00:00:00Z", "--execute"]);

    expect(countMissingBodyMeasurementSamples).not.toHaveBeenCalled();
    expect(backfillMissingBodyMeasurementSamples).toHaveBeenCalledOnce();
    expect(consoleLog).toHaveBeenCalledWith("[body-measurement-backfill] found 12 missing rows");
    expect(Sentry.close).toHaveBeenCalledWith(2_000);
  });
});
