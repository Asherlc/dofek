import { describe, expect, it } from "vitest";
import { parseActivityOverviewAvailabilityBackfillOptions } from "./backfill-activity-overview-availability.ts";

describe("parseActivityOverviewAvailabilityBackfillOptions", () => {
  it("requires an explicit UTC range and defaults to a dry run", () => {
    expect(
      parseActivityOverviewAvailabilityBackfillOptions([
        "--start",
        "2026-03-01T00:00:00Z",
        "--end",
        "2026-04-01T00:00:00+00:00",
      ]),
    ).toEqual({
      start: new Date("2026-03-01T00:00:00Z"),
      end: new Date("2026-04-01T00:00:00Z"),
      execute: false,
    });
  });

  it("enables writes only with --execute", () => {
    expect(
      parseActivityOverviewAvailabilityBackfillOptions([
        "--start",
        "2026-03-01T00:00:00Z",
        "--end",
        "2026-04-01T00:00:00Z",
        "--execute",
      ]).execute,
    ).toBe(true);
  });

  it("accepts a window of exactly 31 days", () => {
    expect(
      parseActivityOverviewAvailabilityBackfillOptions([
        "--start",
        "2026-03-01T00:00:00Z",
        "--end",
        "2026-04-01T00:00:00Z",
      ]),
    ).toMatchObject({
      start: new Date("2026-03-01T00:00:00Z"),
      end: new Date("2026-04-01T00:00:00Z"),
    });
  });

  it.each([
    { args: [], message: "--start is required" },
    {
      args: ["--start", "2026-03-01T00:00:00Z"],
      message: "--end is required",
    },
    {
      args: ["--start", "2026-03-01", "--end", "2026-04-01T00:00:00Z"],
      message: "--start must include an explicit UTC time zone",
    },
    {
      args: ["--start", "2026-03-01T00:00:00-08:00", "--end", "2026-04-01T00:00:00Z"],
      message: "--start must use UTC",
    },
    {
      args: ["--start", "2026-04-01T00:00:00Z", "--end", "2026-03-01T00:00:00Z"],
      message: "--start must be before --end",
    },
    {
      args: ["--start", "2026-03-01T00:00:00Z", "--end", "2026-04-01T00:00:00.001Z"],
      message: "Backfill window must not exceed 31 days",
    },
  ])("rejects unsafe bounds", ({ args, message }) => {
    expect(() => parseActivityOverviewAvailabilityBackfillOptions(args)).toThrow(message);
  });
});
