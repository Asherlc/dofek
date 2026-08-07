import { describe, expect, it } from "vitest";
import { parseSleepQualityBackfillOptions } from "./backfill-sleep-quality.ts";

describe("parseSleepQualityBackfillOptions", () => {
  it("requires an explicit bounded UTC range and defaults to a dry run", () => {
    expect(
      parseSleepQualityBackfillOptions([
        "--start",
        "2026-06-01T00:00:00Z",
        "--end",
        "2026-07-01T00:00:00+00:00",
      ]),
    ).toEqual({
      start: new Date("2026-06-01T00:00:00Z"),
      end: new Date("2026-07-01T00:00:00Z"),
      execute: false,
    });
  });

  it("enables writes only with --execute", () => {
    expect(
      parseSleepQualityBackfillOptions([
        "--start",
        "2026-06-01T00:00:00Z",
        "--end",
        "2026-07-01T00:00:00Z",
        "--execute",
      ]).execute,
    ).toBe(true);
  });

  it.each([
    { args: [], message: "--start is required" },
    {
      args: ["--start", "2026-06-01T00:00:00Z"],
      message: "--end is required",
    },
    {
      args: ["--start", "2026-06-01", "--end", "2026-07-01T00:00:00Z"],
      message: "--start must include an explicit UTC time zone",
    },
    {
      args: ["--start", "2026-06-01T00:00:00-07:00", "--end", "2026-07-01T00:00:00Z"],
      message: "--start must use UTC",
    },
    {
      args: ["--start", "2026-07-01T00:00:00Z", "--end", "2026-06-01T00:00:00Z"],
      message: "--start must be before --end",
    },
    {
      args: ["--start", "2026-06-01T00:00:00Z", "--end", "2026-07-03T00:00:00Z"],
      message: "Backfill window must not exceed 31 days",
    },
  ])("rejects unsafe bounds", ({ args, message }) => {
    expect(() => parseSleepQualityBackfillOptions(args)).toThrow(message);
  });
});
