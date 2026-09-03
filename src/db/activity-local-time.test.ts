import { describe, expect, it } from "vitest";
import {
  resolvePlausibleActivityLocalTime,
  type SuppliedActivityLocalTime,
} from "./activity-local-time.ts";

const pelotonOffset: SuppliedActivityLocalTime = {
  timezone: null,
  startUtcOffsetMinutes: -240,
  endUtcOffsetMinutes: -240,
  source: "provider_offset",
};

describe("resolvePlausibleActivityLocalTime", () => {
  it("rejects an implausible summer provider offset and preserves the observation", () => {
    expect(
      resolvePlausibleActivityLocalTime({
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        endedAt: new Date("2026-09-01T15:25:54.000Z"),
        supplied: pelotonOffset,
        homeTimezone: "America/Los_Angeles",
      }),
    ).toEqual({
      context: {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        source: "home_zone_fallback",
      },
      rejected: pelotonOffset,
      reference: { source: "home_zone", timezone: "America/Los_Angeles" },
    });
  });

  it("evaluates the expected home-zone offset at the winter activity instant", () => {
    expect(
      resolvePlausibleActivityLocalTime({
        startedAt: new Date("2026-01-15T18:00:00.000Z"),
        supplied: {
          timezone: null,
          startUtcOffsetMinutes: -480,
          endUtcOffsetMinutes: null,
          source: "provider_offset",
        },
        homeTimezone: "America/Los_Angeles",
      }).context,
    ).toEqual({
      timezone: null,
      startUtcOffsetMinutes: -480,
      endUtcOffsetMinutes: null,
      source: "provider_offset",
    });
  });

  it("accepts a supplied context exactly 60 minutes from the reference", () => {
    const result = resolvePlausibleActivityLocalTime({
      startedAt: new Date("2026-09-01T14:55:54.000Z"),
      supplied: {
        timezone: null,
        startUtcOffsetMinutes: -360,
        endUtcOffsetMinutes: null,
        source: "provider_offset",
      },
      homeTimezone: "America/Los_Angeles",
    });

    expect(result.context.startUtcOffsetMinutes).toBe(-360);
    expect(result.rejected).toBeNull();
  });

  it("uses a GPS-derived zone ahead of the configured home zone", () => {
    const result = resolvePlausibleActivityLocalTime({
      startedAt: new Date("2026-09-01T14:55:54.000Z"),
      supplied: pelotonOffset,
      homeTimezone: "America/New_York",
      coordinates: { latitude: 38.827, longitude: -123.56 },
    });

    expect(result.reference).toEqual({ source: "gps", timezone: "America/Los_Angeles" });
    expect(result.context).toEqual({
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: null,
      source: "gps_timezone",
    });
  });

  it("resolves honest unknown context through the home zone without a rejected value", () => {
    const result = resolvePlausibleActivityLocalTime({
      startedAt: new Date("2026-09-01T14:55:54.000Z"),
      supplied: {
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        source: "unknown",
      },
      homeTimezone: "America/Los_Angeles",
    });

    expect(result.context.source).toBe("home_zone_fallback");
    expect(result.rejected).toBeNull();
  });

  it("hard-fails a repair when neither GPS nor a home zone can establish plausibility", () => {
    expect(() =>
      resolvePlausibleActivityLocalTime({
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        supplied: pelotonOffset,
        requireReferenceTimezone: true,
      }),
    ).toThrow("activity local-time plausibility requires GPS coordinates or a home timezone");
  });
});
