import { describe, expect, it } from "vitest";
import {
  formatRecordLocalTime,
  localTimeContextUnknown,
  offsetMinutesFromTimestamp,
  recordLocalHour,
  resolveRecordLocalTimeContext,
  resolveTimestampOffsetLocalTimeContext,
} from "./record-local-time.ts";

describe("resolveRecordLocalTimeContext", () => {
  it("resolves start and end independently when a session crosses daylight saving time", () => {
    expect(
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-03-08T09:30:00.000Z"),
        endedAt: new Date("2026-03-08T10:30:00.000Z"),
        timezone: "America/Los_Angeles",
        source: "provider_timezone",
      }),
    ).toEqual({
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -480,
      endUtcOffsetMinutes: -420,
      source: "provider_timezone",
    });
  });

  it("retains independent explicit provider offsets without inventing an IANA timezone", () => {
    expect(
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-10-24T15:00:00.000Z"),
        endedAt: new Date("2026-10-24T17:00:00.000Z"),
        startUtcOffsetMinutes: 660,
        endUtcOffsetMinutes: 600,
        source: "provider_offset",
      }),
    ).toEqual({
      timezone: null,
      startUtcOffsetMinutes: 660,
      endUtcOffsetMinutes: 600,
      source: "provider_offset",
    });
  });

  it("keeps unknown context entirely null", () => {
    expect(localTimeContextUnknown()).toEqual({
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      source: "unknown",
    });
  });

  it("rejects context attached to the unknown source", () => {
    expect(() =>
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        timezone: "UTC",
        source: "unknown",
      }),
    ).toThrow("Unknown local-time context cannot include a timezone or UTC offset");
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() =>
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        timezone: "Mars/Olympus_Mons",
        source: "device_timezone",
      }),
    ).toThrow("Invalid IANA timezone");
  });

  it("rejects an explicit offset outside the civil UTC offset range", () => {
    expect(() =>
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        startUtcOffsetMinutes: 841,
        source: "device_offset",
      }),
    ).toThrow("UTC offset minutes must be an integer between -840 and 840");
  });

  it.each([
    ["startedAt", { startedAt: new Date("invalid") }],
    [
      "endedAt",
      {
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        endedAt: new Date("invalid"),
      },
    ],
  ])("rejects an invalid %s", (field, dates) => {
    expect(() =>
      resolveRecordLocalTimeContext({
        ...dates,
        source: "unknown",
      }),
    ).toThrow(`${field} must be a valid Date`);
  });

  it.each([-841, 840.5, 841])("rejects the invalid explicit offset %s", (offset) => {
    expect(() =>
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        startUtcOffsetMinutes: offset,
        source: "device_offset",
      }),
    ).toThrow("UTC offset minutes must be an integer between -840 and 840");
  });

  it.each([-840, 840])("accepts the civil UTC offset boundary %s", (offset) => {
    expect(
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        startUtcOffsetMinutes: offset,
        source: "device_offset",
      }).startUtcOffsetMinutes,
    ).toBe(offset);
  });

  it("trims a provider timezone before storing it", () => {
    expect(
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        timezone: "  UTC  ",
        source: "provider_timezone",
      }),
    ).toMatchObject({ timezone: "UTC", startUtcOffsetMinutes: 0 });
  });

  it("requires timezone sources to provide a timezone", () => {
    expect(() =>
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        source: "device_timezone",
      }),
    ).toThrow("device_timezone local-time context requires an IANA timezone");
  });

  it("rejects a timezone attached to an offset source", () => {
    expect(() =>
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        timezone: "UTC",
        startUtcOffsetMinutes: 0,
        source: "provider_offset",
      }),
    ).toThrow("provider_offset local-time context cannot include an IANA timezone");
  });

  it("requires offset sources to provide a start offset", () => {
    expect(() =>
      resolveRecordLocalTimeContext({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        source: "provider_offset",
      }),
    ).toThrow("provider_offset local-time context requires a start UTC offset");
  });
});

describe("offsetMinutesFromTimestamp", () => {
  it.each([
    ["2026-01-01T10:00:00-08:00", -480],
    ["2026-01-01T10:00:00+05:30", 330],
    ["2026-01-01T10:00:00+1245", 765],
    ["2026-01-01T10:00:00Z", 0],
  ])("extracts the explicit offset from %s", (timestamp, expected) => {
    expect(offsetMinutesFromTimestamp(timestamp)).toBe(expected);
  });

  it("returns null when the timestamp carries no explicit offset", () => {
    expect(offsetMinutesFromTimestamp("2026-01-01T10:00:00")).toBeNull();
  });

  it.each([
    "2026-01-01T10:00:00Z-extra",
    "2026-01-01T10:00:00+14:01",
    "2026-01-01T10:00:00+15:00",
    "2026-01-01T10:00:00+01:60",
    "2026-01-01T10:00:00+05:30-extra",
  ])("rejects the malformed or out-of-range offset in %s", (timestamp) => {
    expect(offsetMinutesFromTimestamp(timestamp)).toBeNull();
  });

  it.each([
    ["2026-01-01T10:00:00+14:00", 840],
    ["2026-01-01T10:00:00-14:00", -840],
  ])("accepts the civil offset boundary in %s", (timestamp, expected) => {
    expect(offsetMinutesFromTimestamp(timestamp)).toBe(expected);
  });
});

describe("resolveTimestampOffsetLocalTimeContext", () => {
  it("preserves different boundary offsets", () => {
    expect(
      resolveTimestampOffsetLocalTimeContext({
        startedAtTimestamp: "2026-03-08T01:30:00-08:00",
        endedAtTimestamp: "2026-03-08T03:30:00-07:00",
        source: "provider_offset",
      }),
    ).toEqual({
      timezone: null,
      startUtcOffsetMinutes: -480,
      endUtcOffsetMinutes: -420,
      source: "provider_offset",
    });
  });

  it("returns unknown when either timestamp has no offset", () => {
    expect(
      resolveTimestampOffsetLocalTimeContext({
        startedAtTimestamp: "2026-03-08T01:30:00",
        endedAtTimestamp: "2026-03-08T03:30:00-07:00",
        source: "device_offset",
      }),
    ).toEqual(localTimeContextUnknown());
  });
});

describe("formatRecordLocalTime", () => {
  const dstContext = {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -480,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone" as const,
  };

  it("prefers the IANA timezone for start and end clock times", () => {
    expect(formatRecordLocalTime("2026-03-08T09:30:00.000Z", dstContext, "start", "en-US")).toBe(
      "1:30 AM",
    );
    expect(formatRecordLocalTime("2026-03-08T10:30:00.000Z", dstContext, "end", "en-US")).toBe(
      "3:30 AM",
    );
  });

  it("falls back to the stored fixed offset when no IANA timezone exists", () => {
    expect(
      formatRecordLocalTime(
        "2026-01-01T00:15:00.000Z",
        {
          timezone: null,
          startUtcOffsetMinutes: 330,
          endUtcOffsetMinutes: null,
          source: "provider_offset",
        },
        "start",
        "en-US",
      ),
    ).toBe("5:45 AM");
  });

  it("does not guess when the requested boundary offset is unknown", () => {
    expect(
      formatRecordLocalTime(
        "2026-01-01T00:15:00.000Z",
        {
          timezone: null,
          startUtcOffsetMinutes: 330,
          endUtcOffsetMinutes: null,
          source: "provider_offset",
        },
        "end",
        "en-US",
      ),
    ).toBe("--");
  });

  it("formats an unknown activity-local context in the viewer timezone when supplied", () => {
    expect(
      formatRecordLocalTime(
        "2026-08-27T14:51:43.000Z",
        localTimeContextUnknown(),
        "start",
        "en-US",
        "America/Los_Angeles",
      ),
    ).toBe("7:51 AM");
  });

  it("returns a placeholder for invalid timestamps and timezones", () => {
    expect(formatRecordLocalTime("invalid", dstContext, "start", "en-US")).toBe("--");
    expect(
      formatRecordLocalTime(
        "2026-03-08T09:30:00.000Z",
        { ...dstContext, timezone: "Mars/Olympus_Mons" },
        "start",
        "en-US",
      ),
    ).toBe("--");
  });
});

describe("recordLocalHour", () => {
  it("uses the stored offset instead of the runtime timezone", () => {
    expect(
      recordLocalHour("2026-07-14T08:30:00.000Z", {
        timezone: null,
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        source: "provider_offset",
      }),
    ).toBe(1.5);
  });

  it("returns null for unknown context", () => {
    expect(recordLocalHour("2026-07-14T08:30:00.000Z", localTimeContextUnknown())).toBeNull();
  });

  it("uses the selected end offset", () => {
    expect(
      recordLocalHour(
        "2026-07-14T08:30:00.000Z",
        {
          timezone: null,
          startUtcOffsetMinutes: -420,
          endUtcOffsetMinutes: 330,
          source: "provider_offset",
        },
        "end",
      ),
    ).toBe(14);
  });

  it("uses an IANA timezone when present", () => {
    expect(
      recordLocalHour("2026-07-14T08:30:00.000Z", {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        source: "provider_timezone",
      }),
    ).toBe(1.5);
  });

  it("returns null for invalid timestamps and timezones", () => {
    expect(recordLocalHour("invalid", localTimeContextUnknown())).toBeNull();
    expect(
      recordLocalHour("2026-07-14T08:30:00.000Z", {
        timezone: "Mars/Olympus_Mons",
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        source: "provider_timezone",
      }),
    ).toBeNull();
  });
});
