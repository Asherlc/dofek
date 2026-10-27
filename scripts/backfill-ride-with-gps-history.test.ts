import { describe, expect, it } from "vitest";
import { parseRideWithGpsHistoryBackfillArgs } from "./backfill-ride-with-gps-history.ts";

describe("parseRideWithGpsHistoryBackfillArgs", () => {
  it("defaults to a dry run over the full historical window", () => {
    const options = parseRideWithGpsHistoryBackfillArgs([]);

    expect(options.execute).toBe(false);
    expect(options.since).toEqual(new Date(0));
    expect(options.until).toBeInstanceOf(Date);
  });

  it("parses execute, user id, and date bounds", () => {
    const options = parseRideWithGpsHistoryBackfillArgs([
      "--execute",
      "--user-id",
      "user-1",
      "--start",
      "2009-01-01T00:00:00.000Z",
      "--end",
      "2026-07-11T00:00:00.000Z",
    ]);

    expect(options).toEqual({
      execute: true,
      userId: "user-1",
      since: new Date("2009-01-01T00:00:00.000Z"),
      until: new Date("2026-07-11T00:00:00.000Z"),
    });
  });

  it.each([
    {
      args: ["--user-id"],
      message: "--user-id requires a value",
    },
    {
      args: ["--start"],
      message: "--start requires a value",
    },
    {
      args: ["--end", "--execute"],
      message: "--end requires a value",
    },
    {
      args: ["--start", "not-a-date"],
      message: "--start must be an ISO date or timestamp",
    },
    {
      args: ["--start", "2026-02-30"],
      message: "--start must be a valid calendar date",
    },
    {
      args: ["--start", "2026-07-11", "--end", "2026-07-10"],
      message: "--start date must be before or equal to --end date",
    },
    {
      args: ["--unknown"],
      message: "Unknown argument: --unknown",
    },
  ])("rejects malformed arguments: $message", ({ args, message }) => {
    expect(() => parseRideWithGpsHistoryBackfillArgs(args)).toThrow(message);
  });

  it("uses the last duplicate date bound", () => {
    const options = parseRideWithGpsHistoryBackfillArgs([
      "--start",
      "2009-01-01T00:00:00.000Z",
      "--start",
      "2010-01-01T00:00:00.000Z",
    ]);

    expect(options.since).toEqual(new Date("2010-01-01T00:00:00.000Z"));
  });

  it("treats a date-only end value as the inclusive UTC day end", () => {
    const options = parseRideWithGpsHistoryBackfillArgs(["--end", "2026-07-11"]);

    expect(options.until).toEqual(new Date("2026-07-11T23:59:59.999Z"));
  });
});
