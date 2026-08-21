import { describe, expect, it } from "vitest";
import { SyncWindow } from "../providers/sync-window.ts";
import {
  syncWindowFromJobData,
  syncWindowFromTriggerInput,
  syncWindowToJobData,
} from "./sync-job-window.ts";

describe("SyncWindow", () => {
  const now = new Date("2026-06-18T15:00:00.000Z");

  it("fromDateRange resolves UTC calendar bounds", () => {
    const window = SyncWindow.fromDateRange({ sinceDate: "2026-06-10", untilDate: "2026-06-17" });

    expect(window.since.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-17T23:59:59.999Z");
  });

  it("rejects overflow calendar dates instead of normalizing them", () => {
    expect(() =>
      SyncWindow.fromDateRange({ sinceDate: "2026-02-31", untilDate: "2026-03-01" }),
    ).toThrow("Invalid sync window date: 2026-02-31");
    expect(() => SyncWindow.lastDays(7, { untilDate: "2026-13-01", now })).toThrow(
      "Invalid sync window date: 2026-13-01",
    );
  });

  it("rejects non-finite constructor bounds with the exact boundary name", () => {
    expect(
      () =>
        new SyncWindow({
          since: new Date(Number.NaN),
          until: new Date("2026-06-18T15:00:00.000Z"),
        }),
    ).toThrow("Invalid sync window since");
    expect(() =>
      SyncWindow.fromSince({
        since: new Date("2026-06-10T00:00:00.000Z"),
        until: new Date(Number.NaN),
      }),
    ).toThrow("Invalid sync window until");
  });

  it("lastDays resolves relative to the anchor day", () => {
    const window = SyncWindow.lastDays(7, { now });

    expect(window.since.toISOString()).toBe("2026-06-11T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-18T23:59:59.999Z");
  });

  it("full spans epoch through now", () => {
    const window = SyncWindow.full(now);

    expect(window.since.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(window.until).toEqual(now);
  });

  it("fromSince defaults until to now", () => {
    const since = new Date("2026-06-10T00:00:00.000Z");
    const until = new Date("2026-06-18T15:00:00.000Z");
    const window = SyncWindow.fromSince({ since: since, until: until });

    expect(window.since).toEqual(since);
    expect(window.until).toEqual(until);
  });

  it("defensively copies dates from constructor input and getters", () => {
    const since = new Date("2026-06-10T00:00:00.000Z");
    const until = new Date("2026-06-18T15:00:00.000Z");
    const window = new SyncWindow({ since, until });

    since.setUTCFullYear(2020);
    until.setUTCFullYear(2020);
    window.since.setUTCFullYear(2021);
    window.until.setUTCFullYear(2021);

    expect(window.since.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-18T15:00:00.000Z");
  });

  it("withMinimumLookback widens the start bound", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-06-15",
      untilDate: "2026-06-17",
    }).withMinimumLookback(30);

    expect(window.since.toISOString()).toBe("2026-05-18T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-17T23:59:59.999Z");
  });
});

describe("sync job window adapter", () => {
  const now = new Date("2026-06-18T15:00:00.000Z");

  it("syncWindowFromTriggerInput resolves lastDays", () => {
    const window = syncWindowFromTriggerInput({ sinceDays: 7, now });
    expect(window.since.toISOString()).toBe("2026-06-11T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-18T23:59:59.999Z");
  });

  it("syncWindowFromTriggerInput resolves explicit date ranges", () => {
    const window = syncWindowFromTriggerInput({
      sinceDate: "2026-06-10",
      untilDate: "2026-06-17",
      now,
    });

    expect(window.since.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-17T23:59:59.999Z");
  });

  it("syncWindowFromTriggerInput rejects incomplete explicit date ranges", () => {
    expect(() => syncWindowFromTriggerInput({ sinceDate: "2026-06-10", now })).toThrow(
      "untilDate is required when sinceDate is set",
    );
    expect(() => syncWindowFromTriggerInput({ untilDate: "2026-06-17", now })).toThrow(
      "sinceDate is required when untilDate is set",
    );
  });

  it("syncWindowFromTriggerInput applies untilDate to relative windows", () => {
    const window = syncWindowFromTriggerInput({
      sinceDays: 7,
      untilDate: "2026-06-17",
      now,
    });

    expect(window.since.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-17T23:59:59.999Z");
  });

  it("syncWindowFromJobData reuses persisted ISO timestamps", () => {
    const window = syncWindowFromJobData({
      userId: "user-1",
      sinceIso: "2026-06-10T00:00:00.000Z",
      untilIso: "2026-06-17T23:59:59.999Z",
    });

    expect(window.since.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-17T23:59:59.999Z");
  });

  it("syncWindowFromJobData reuses persisted open-ended since timestamps", () => {
    const window = syncWindowFromJobData(
      {
        userId: "user-1",
        sinceIso: "2026-06-10T00:00:00.000Z",
      },
      now,
    );

    expect(window.since.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(window.until).toEqual(now);
  });

  it("syncWindowFromJobData rejects invalid persisted since timestamps", () => {
    expect(() => syncWindowFromJobData({ userId: "user-1", sinceIso: "not-a-date" }, now)).toThrow(
      "Invalid sync job sinceIso: not-a-date",
    );
  });

  it("syncWindowToJobData round-trips trigger input fields", () => {
    const window = syncWindowFromTriggerInput({ sinceDays: 7, now });
    expect(syncWindowToJobData(window, 7)).toEqual({
      sinceDays: 7,
      sinceIso: "2026-06-11T00:00:00.000Z",
      untilIso: "2026-06-18T23:59:59.999Z",
      targetRefreshWindow: { type: "days", days: 7 },
    });
  });

  it("syncWindowToJobData encodes full windows", () => {
    const window = SyncWindow.full(now);
    expect(syncWindowToJobData(window)).toEqual({
      sinceDays: undefined,
      sinceIso: "1970-01-01T00:00:00.000Z",
      untilIso: "2026-06-18T15:00:00.000Z",
      targetRefreshWindow: { type: "full" },
    });
  });

  it("syncWindowToJobData encodes custom ranges", () => {
    const window = SyncWindow.fromDateRange({ sinceDate: "2026-06-10", untilDate: "2026-06-17" });
    expect(syncWindowToJobData(window)).toEqual({
      sinceDays: undefined,
      sinceIso: "2026-06-10T00:00:00.000Z",
      untilIso: "2026-06-17T23:59:59.999Z",
      targetRefreshWindow: {
        type: "range",
        sinceIso: "2026-06-10T00:00:00.000Z",
        untilIso: "2026-06-17T23:59:59.999Z",
      },
    });
  });
});
