import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";

const clickHouseMocks = vi.hoisted(() => {
  const query = vi.fn();
  const close = vi.fn();
  return {
    query,
    close,
    createClickHouseClientFromEnv: vi.fn(() => ({ query, close })),
  };
});

vi.mock("../../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: clickHouseMocks.createClickHouseClientFromEnv,
}));

const pendingQueryMocks = vi.hoisted(() => ({
  listPendingSyncRequestQueryKeys: vi.fn(async () => new Set<string>()),
}));

vi.mock("../../lib/sync-request-queue.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sync-request-queue.ts")>();
  return {
    ...actual,
    listPendingSyncRequestQueryKeys: pendingQueryMocks.listPendingSyncRequestQueryKeys,
  };
});

import {
  applyRateLimitToCheckpoint,
  createGarminSyncCheckpoint,
  type GarminSyncCheckpoint,
  insertStepsAfterCurrent,
  parseGarminSyncCheckpoint,
} from "./sync-checkpoint.ts";
import { planGarminSyncSteps } from "./sync-step-plan.ts";

beforeEach(() => {
  clickHouseMocks.createClickHouseClientFromEnv.mockClear();
  clickHouseMocks.query.mockReset();
  clickHouseMocks.query.mockResolvedValue({ json: async () => [] });
  clickHouseMocks.close.mockClear();
  delete process.env.CLICKHOUSE_URL;
});

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
      { type: "activities_list", offset: 0 },
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

const sampleCheckpoint: GarminSyncCheckpoint = {
  runId: "run-1",
  recordsSynced: 3,
  phase: "api",
  steps: [
    { type: "activities_list", offset: 0 },
    { type: "sleep", date: "2026-03-01" },
    { type: "daily_summary", date: "2026-03-01" },
    { type: "hrv_summary", date: "2026-03-01" },
    { type: "stress", date: "2026-03-01" },
    { type: "heart_rate", date: "2026-03-01" },
  ],
  stepIndex: 0,
  presentActivityExternalIds: [],
};

describe("createGarminSyncCheckpoint", () => {
  it("bootstraps an empty checkpoint with the planned steps", () => {
    const checkpoint = createGarminSyncCheckpoint([{ type: "activities_list", offset: 0 }]);

    expect(checkpoint.phase).toBe("api");
    expect(checkpoint.stepIndex).toBe(0);
    expect(checkpoint.recordsSynced).toBe(0);
    expect(checkpoint.presentActivityExternalIds).toEqual([]);
    expect(checkpoint.steps).toEqual([{ type: "activities_list", offset: 0 }]);
    expect(checkpoint.runId.length).toBeGreaterThan(0);
  });
});

describe("insertStepsAfterCurrent", () => {
  it("returns the same checkpoint when no follow-up steps are provided", () => {
    const checkpoint = createGarminSyncCheckpoint([{ type: "activities_list", offset: 0 }]);
    expect(insertStepsAfterCurrent(checkpoint, [])).toBe(checkpoint);
  });

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
      { type: "activity_detail", activityId: 123, activityModality: null },
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
  it("parses a valid checkpoint payload", () => {
    expect(parseGarminSyncCheckpoint(sampleCheckpoint)).toEqual(sampleCheckpoint);
  });

  it("rejects legacy phase checkpoints", () => {
    expect(parseGarminSyncCheckpoint({ phase: "sleep", nextDate: "2026-03-01" })).toBeNull();
  });

  it("rejects checkpoints with out-of-range stepIndex or negative recordsSynced", () => {
    expect(
      parseGarminSyncCheckpoint({
        ...sampleCheckpoint,
        stepIndex: -1,
      }),
    ).toBeNull();
    expect(
      parseGarminSyncCheckpoint({
        ...sampleCheckpoint,
        stepIndex: sampleCheckpoint.steps.length + 1,
      }),
    ).toBeNull();
    expect(
      parseGarminSyncCheckpoint({
        ...sampleCheckpoint,
        recordsSynced: -1,
      }),
    ).toBeNull();
  });
});

describe("applyRateLimitToCheckpoint", () => {
  it("drops remaining stress, heart rate, and HRV steps after a rate limit", () => {
    const checkpoint = applyRateLimitToCheckpoint({
      ...sampleCheckpoint,
      stepIndex: 0,
    });

    expect(checkpoint.steps).toEqual([
      { type: "activities_list", offset: 0 },
      { type: "sleep", date: "2026-03-01" },
      { type: "daily_summary", date: "2026-03-01" },
    ]);
  });

  it("does not keep stress, heart rate, or HRV as the current step after a rate limit", () => {
    const checkpoint = applyRateLimitToCheckpoint({
      ...sampleCheckpoint,
      stepIndex: 4,
    });

    expect(checkpoint.steps).toEqual([
      { type: "activities_list", offset: 0 },
      { type: "sleep", date: "2026-03-01" },
      { type: "daily_summary", date: "2026-03-01" },
      { type: "hrv_summary", date: "2026-03-01" },
    ]);
  });

  it("keeps non-low-priority tail steps after the current API step index", () => {
    const checkpoint = applyRateLimitToCheckpoint({
      ...sampleCheckpoint,
      steps: [
        { type: "activities_list", offset: 0 },
        { type: "activity_reconcile" },
        { type: "sleep", date: "2026-03-01" },
        { type: "stress", date: "2026-03-01" },
        { type: "heart_rate", date: "2026-03-01" },
      ],
      stepIndex: 1,
    });

    expect(checkpoint.steps).toEqual([
      { type: "activities_list", offset: 0 },
      { type: "activity_reconcile" },
      { type: "sleep", date: "2026-03-01" },
    ]);
  });
});
