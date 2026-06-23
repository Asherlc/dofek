import { describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import {
  createGarminSyncCheckpoint,
  insertStepsAfterCurrent,
  parseGarminSyncCheckpoint,
} from "./sync-checkpoint.ts";
import { planGarminSyncSteps } from "./sync-step-plan.ts";

function makeDb(): SyncDatabase {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(Promise.resolve([]));

  return {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  };
}

describe("planGarminSyncSteps", () => {
  it("plans one HTTP step per data call in phase order", async () => {
    const steps = await planGarminSyncSteps({
      db: makeDb(),
      providerId: "garmin",
      userId: "00000000-0000-0000-0000-000000000001",
      sinceDate: "2026-03-01",
      untilDate: "2026-03-02",
      dates: ["2026-03-01", "2026-03-02"],
    });
    expect(steps).toEqual([
      { type: "activities_list" },
      { type: "sleep", date: "2026-03-01" },
      { type: "daily_summary", date: "2026-03-01" },
      { type: "hrv_summary", date: "2026-03-01" },
      { type: "stress", date: "2026-03-01" },
      { type: "heart_rate", date: "2026-03-01" },
      { type: "sleep", date: "2026-03-02" },
      { type: "daily_summary", date: "2026-03-02" },
      { type: "hrv_summary", date: "2026-03-02" },
      { type: "stress", date: "2026-03-02" },
      { type: "heart_rate", date: "2026-03-02" },
    ]);
  });
});

describe("insertStepsAfterCurrent", () => {
  it("splices follow-up activity steps after the activities list step", async () => {
    const checkpoint = createGarminSyncCheckpoint(
      await planGarminSyncSteps({
        db: makeDb(),
        providerId: "garmin",
        userId: "00000000-0000-0000-0000-000000000001",
        sinceDate: "2026-03-01",
        untilDate: "2026-03-01",
        dates: ["2026-03-01"],
      }),
    );
    const next = insertStepsAfterCurrent(checkpoint, [
      { type: "activity_detail", activityId: 123, activityType: "running" },
      { type: "activity_reconcile" },
    ]);
    expect(next.steps.map((step) => step.type)).toEqual([
      "activities_list",
      "activity_detail",
      "activity_reconcile",
      "sleep",
      "daily_summary",
      "hrv_summary",
      "stress",
      "heart_rate",
    ]);
  });
});

describe("parseGarminSyncCheckpoint", () => {
  it("rejects legacy phase checkpoints", () => {
    expect(parseGarminSyncCheckpoint({ phase: "sleep", nextDate: "2026-03-01" })).toBeNull();
  });
});
