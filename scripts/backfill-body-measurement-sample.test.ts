import { describe, expect, it } from "vitest";
import { parseBodyMeasurementSampleBackfillOptions } from "./backfill-body-measurement-sample.ts";

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
