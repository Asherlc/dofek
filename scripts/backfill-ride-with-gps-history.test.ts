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
});
