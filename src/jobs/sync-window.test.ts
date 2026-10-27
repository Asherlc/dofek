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

    expect(window.kind).toBe("full");
    expect(window.since.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(window.until).toEqual(now);
  });

  it("keeps an explicit epoch-start range bounded", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "1970-01-01",
      untilDate: "1970-01-05",
    });

    expect(window.kind).toBe("bounded");
    expect(window.since.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("1970-01-05T23:59:59.999Z");
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

  it("withMinimumLookback preserves full and bounded semantics", () => {
    const fullWindow = SyncWindow.full(now).withMinimumLookback(30);
    const boundedWindow = SyncWindow.fromDateRange({
      sinceDate: "2026-06-15",
      untilDate: "2026-06-17",
    }).withMinimumLookback(30);

    expect(fullWindow.kind).toBe("full");
    expect(boundedWindow.kind).toBe("bounded");
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

  it("syncWindowFromJobData anchors relative windows to the persisted request time", () => {
    const window = syncWindowFromJobData({
      userId: "user-1",
      requestedAtIso: "2026-06-18T15:00:00.000Z",
      sinceDays: 7,
    });

    expect(window.since.toISOString()).toBe("2026-06-11T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-06-18T23:59:59.999Z");
  });

  it("syncWindowFromJobData rejects an invalid persisted request time", () => {
    expect(() =>
      syncWindowFromJobData(
        {
          userId: "user-1",
          requestedAtIso: "not-a-date",
          sinceDays: 7,
        },
        now,
      ),
    ).toThrow("Invalid sync job requestedAtIso: not-a-date");
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
    expect(window.kind).toBe("bounded");
  });

  it("syncWindowFromJobData preserves full kind for an open-ended persisted window", () => {
    const window = syncWindowFromJobData(
      {
        userId: "user-1",
        sinceIso: "1970-01-01T00:00:00.000Z",
        targetRefreshWindow: { type: "full" },
      },
      now,
    );

    expect(window.since.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(window.until).toEqual(now);
    expect(window.kind).toBe("full");
  });

  it("syncWindowFromJobData rejects invalid persisted since timestamps", () => {
    expect(() => syncWindowFromJobData({ userId: "user-1", sinceIso: "not-a-date" }, now)).toThrow(
      "Invalid sync job sinceIso: not-a-date",
    );
  });

  it("syncWindowToJobData round-trips trigger input fields", () => {
    const window = syncWindowFromTriggerInput({ sinceDays: 7, now });
    expect(syncWindowToJobData(window, { sinceDays: 7 })).toEqual({
      sinceDays: 7,
      sinceIso: "2026-06-11T00:00:00.000Z",
      untilIso: "2026-06-18T23:59:59.999Z",
      targetRefreshWindow: { type: "days", days: 7 },
    });
  });

  it("syncWindowToJobData keeps a day lookback with an explicit end as a fixed range", () => {
    const window = syncWindowFromTriggerInput({
      sinceDays: 7,
      untilDate: "2026-06-17",
      now,
    });

    expect(syncWindowToJobData(window, { sinceDays: 7, untilDate: "2026-06-17" })).toEqual({
      sinceDays: 7,
      sinceIso: "2026-06-10T00:00:00.000Z",
      untilIso: "2026-06-17T23:59:59.999Z",
      targetRefreshWindow: {
        type: "range",
        sinceIso: "2026-06-10T00:00:00.000Z",
        untilIso: "2026-06-17T23:59:59.999Z",
      },
    });
  });

  it("syncWindowToJobData encodes full windows", () => {
    const window = SyncWindow.full(now);
    const jobData = syncWindowToJobData(window);

    expect(jobData).toEqual({
      sinceDays: undefined,
      sinceIso: "1970-01-01T00:00:00.000Z",
      untilIso: "2026-06-18T15:00:00.000Z",
      targetRefreshWindow: { type: "full" },
    });
    expect(syncWindowFromJobData({ userId: "user-1", ...jobData }).kind).toBe("full");
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

  it("round-trips an explicit epoch-start range as bounded", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "1970-01-01",
      untilDate: "1970-01-05",
    });
    const jobData = syncWindowToJobData(window);

    expect(jobData.targetRefreshWindow).toEqual({
      type: "range",
      sinceIso: "1970-01-01T00:00:00.000Z",
      untilIso: "1970-01-05T23:59:59.999Z",
    });
    const restoredWindow = syncWindowFromJobData({ userId: "user-1", ...jobData });
    expect(restoredWindow.kind).toBe("bounded");
    expect(restoredWindow.sinceIso).toBe("1970-01-01T00:00:00.000Z");
    expect(restoredWindow.untilIso).toBe("1970-01-05T23:59:59.999Z");
  });
});
