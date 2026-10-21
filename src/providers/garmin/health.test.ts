import { describe, expect, it } from "vitest";
import { createMockDatabase } from "../test-helpers.ts";
import { syncGarminHealthRecord } from "./health.ts";

describe("syncGarminHealthRecord validation", () => {
  it("requires an explicit Dofek owner before writing any health record", async () => {
    const { db, spies } = createMockDatabase();
    await expect(syncGarminHealthRecord(db, "dailies", {}, {})).rejects.toThrow("userId");
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it.each(["dailies", "sleeps", "hrv", "pulseox", "allDayRespiration"] as const)(
    "validates %s payload before writing",
    async (type) => {
      const { db, spies } = createMockDatabase();
      await expect(
        syncGarminHealthRecord(
          db,
          type,
          {},
          {
            userId: "00000000-0000-0000-0000-000000000001",
          },
        ),
      ).rejects.toThrow();
      expect(spies.insert).not.toHaveBeenCalled();
      expect(spies.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown sleep stages rather than dropping data", async () => {
    const { db, spies } = createMockDatabase();
    await expect(
      syncGarminHealthRecord(
        db,
        "sleeps",
        {
          userId: "garmin-owner",
          summaryId: "sleep-summary",
          calendarDate: "2026-10-20",
          startTimeInSeconds: 1792454400,
          durationInSeconds: 3600,
          sleepLevelsMap: {
            unknown: [{ startTimeInSeconds: 1792454400, endTimeInSeconds: 1792454460 }],
          },
        },
        { userId: "00000000-0000-0000-0000-000000000001" },
      ),
    ).rejects.toThrow("unknown");
    expect(spies.insert).not.toHaveBeenCalled();
  });
});
