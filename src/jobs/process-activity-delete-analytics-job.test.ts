import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockWaitForPeerDbActivityDeletes = vi.fn().mockResolvedValue(undefined);
const mockWaitForPeerDbActivityRestores = vi.fn().mockResolvedValue(undefined);
const mockRunActivityReadModelBuild = vi.fn().mockResolvedValue(undefined);
const mockWaitForMetricStreamDeleteAcknowledgement = vi.fn().mockResolvedValue(undefined);
const mockWaitForPeerDbProviderDeletes = vi.fn().mockResolvedValue(undefined);
const mockInvalidateByPrefix = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockAccountErasureAllowsQueuedUserWork = vi.fn().mockResolvedValue(true);

vi.mock("./account-erasure-work-guard.ts", () => ({
  accountErasureAllowsQueuedUserWork: (database: unknown, userId: string, workKind: string) =>
    mockAccountErasureAllowsQueuedUserWork(database, userId, workKind),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../analytics/activity-read-model-build.ts", () => ({
  waitForPeerDbActivityDeletes: (...args: unknown[]) => mockWaitForPeerDbActivityDeletes(...args),
  waitForPeerDbActivityRestores: (...args: unknown[]) => mockWaitForPeerDbActivityRestores(...args),
  waitForMetricStreamDeleteAcknowledgement: (...args: unknown[]) =>
    mockWaitForMetricStreamDeleteAcknowledgement(...args),
  waitForPeerDbProviderDeletes: (...args: unknown[]) => mockWaitForPeerDbProviderDeletes(...args),
}));

vi.mock("../analytics-refresh-queue.ts", () => ({
  refreshAnalyticsAndWait: (...args: unknown[]) => mockRunActivityReadModelBuild(...args),
}));

vi.mock("../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: () => ({
    query: vi.fn(),
    close: mockClose,
  }),
}));

vi.mock("../lib/cache.ts", () => ({
  invalidateAllUserQueries: (userId: string) => mockInvalidateByPrefix(`${userId}:`),
}));

import { processActivityDeleteAnalyticsJob } from "./process-activity-delete-analytics-job.ts";

const fakeDb = { execute: vi.fn() };
let sharedLockHeld = false;
const sharedLockEntered = vi.fn();
const workLockPool = {
  close: async () => {},
  tryRunWithExclusiveUserLock: async <T>(_userId: string, work: () => Promise<T>) =>
    sharedLockHeld ? undefined : work(),
  runWithSharedUserLock: async <T>(_userId: string, work: () => Promise<T>) => {
    sharedLockEntered();
    sharedLockHeld = true;
    try {
      return await work();
    } finally {
      sharedLockHeld = false;
    }
  },
};

function createActivityAnalyticsJob(
  type:
    | "activity-delete-analytics-refresh"
    | "activity-restore-analytics-refresh"
    | "activity-recompute-analytics-refresh",
  activityIds = ["00000000-0000-0000-0000-000000000001"],
) {
  return {
    data: {
      type,
      userId: "user-1",
      activityIds,
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function createProviderDeleteAnalyticsJob() {
  return {
    data: {
      type: "provider-delete-analytics-refresh" as const,
      userId: "user-1",
      providerId: "strava",
      deletionEventId: "30000000-0000-4000-8000-000000000001",
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

describe("processActivityDeleteAnalyticsJob", () => {
  beforeEach(() => {
    mockWaitForPeerDbActivityDeletes.mockClear();
    mockRunActivityReadModelBuild.mockClear();
    mockInvalidateByPrefix.mockClear();
    mockClose.mockClear();
    mockWaitForPeerDbActivityDeletes.mockResolvedValue(undefined);
    mockWaitForPeerDbActivityRestores.mockClear();
    mockWaitForPeerDbActivityRestores.mockResolvedValue(undefined);
    mockRunActivityReadModelBuild.mockResolvedValue(undefined);
    mockCaptureException.mockClear();
    mockWaitForMetricStreamDeleteAcknowledgement.mockClear();
    mockWaitForPeerDbProviderDeletes.mockClear();
    mockAccountErasureAllowsQueuedUserWork.mockResolvedValue(true);
  });

  it("waits for serialized refresh completion before invalidating cache", async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = () => {};
    const enqueued = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockRunActivityReadModelBuild.mockImplementationOnce(async () => {
      started();
      await pending;
    });
    const job = createActivityAnalyticsJob("activity-recompute-analytics-refresh");
    const processing = processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);
    await enqueued;
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    expect(await workLockPool.tryRunWithExclusiveUserLock("user-1", async () => "erasing")).toBe(
      "erasing",
    );
    finish();
    await processing;
    expect(mockInvalidateByPrefix).toHaveBeenCalledOnce();
    expect(sharedLockEntered).toHaveBeenCalled();
  });

  it("rechecks erasure inside the cache-write lock after the refresh wait", async () => {
    mockRunActivityReadModelBuild.mockImplementationOnce(async () => {
      expect(sharedLockHeld).toBe(false);
      mockAccountErasureAllowsQueuedUserWork.mockImplementation(async () => {
        expect(sharedLockHeld).toBe(true);
        return false;
      });
    });
    await processActivityDeleteAnalyticsJob(
      createActivityAnalyticsJob("activity-recompute-analytics-refresh"),
      fakeDb,
      workLockPool,
    );
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
  });

  it.each(["activity-delete-analytics-refresh", "activity-restore-analytics-refresh"] as const)(
    "skips %s rebuilding when erasure starts during the CDC wait",
    async (type) => {
      const wait =
        type === "activity-delete-analytics-refresh"
          ? mockWaitForPeerDbActivityDeletes
          : mockWaitForPeerDbActivityRestores;
      wait.mockImplementationOnce(async () => {
        mockAccountErasureAllowsQueuedUserWork.mockResolvedValue(false);
      });
      const job = createActivityAnalyticsJob(type);
      await processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);
      expect(wait).toHaveBeenCalledOnce();
      expect(mockRunActivityReadModelBuild).not.toHaveBeenCalled();
      expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
      expect(job.updateProgress.mock.calls.map(([progress]) => progress.percentage)).toEqual([
        0, 20,
      ]);
      expect(mockClose).toHaveBeenCalledOnce();
    },
  );

  it("waits only for Postgres CDC because metric-stream deletion is already acknowledged", async () => {
    const job = createProviderDeleteAnalyticsJob();
    await processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 90,
      message: "Invalidating provider analytics cache...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Provider analytics refresh complete.",
    });
    expect(mockWaitForMetricStreamDeleteAcknowledgement).not.toHaveBeenCalled();
    expect(mockWaitForPeerDbProviderDeletes).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "strava",
    );
    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
  });

  it("waits for PeerDB, rebuilds activity read models, and invalidates user caches", async () => {
    const job = createActivityAnalyticsJob("activity-delete-analytics-refresh");

    await processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);

    expect(mockWaitForPeerDbActivityDeletes).toHaveBeenCalledWith(expect.anything(), [
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("closes the ClickHouse client even when refresh fails", async () => {
    mockRunActivityReadModelBuild.mockRejectedValueOnce(new Error("dbt failed"));
    const job = createActivityAnalyticsJob("activity-delete-analytics-refresh");

    await expect(processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool)).rejects.toThrow(
      "dbt failed",
    );
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("waits for restored activities before rebuilding read models", async () => {
    await processActivityDeleteAnalyticsJob(
      createActivityAnalyticsJob("activity-restore-analytics-refresh", [
        "00000000-0000-0000-0000-000000000002",
      ]),
      fakeDb,
      workLockPool,
    );

    expect(mockWaitForPeerDbActivityRestores).toHaveBeenCalledWith(expect.anything(), [
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(mockWaitForPeerDbActivityDeletes).not.toHaveBeenCalled();
    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("rebuilds read models for recompute without waiting for PeerDB delete or restore state", async () => {
    await processActivityDeleteAnalyticsJob(
      createActivityAnalyticsJob("activity-recompute-analytics-refresh", [
        "00000000-0000-0000-0000-000000000003",
      ]),
      fakeDb,
      workLockPool,
    );

    expect(mockWaitForPeerDbActivityDeletes).not.toHaveBeenCalled();
    expect(mockWaitForPeerDbActivityRestores).not.toHaveBeenCalled();
    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("reports delete analytics progress", async () => {
    const job = createActivityAnalyticsJob("activity-delete-analytics-refresh");

    await processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting activity analytics refresh...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 20,
      message: "Waiting for activity deletes to reach analytics...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 60,
      message: "Rebuilding activity analytics...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 90,
      message: "Invalidating activity analytics cache...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Activity analytics refresh complete.",
    });
  });

  it("reports restore analytics progress", async () => {
    const job = createActivityAnalyticsJob("activity-restore-analytics-refresh");

    await processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting activity analytics refresh...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 20,
      message: "Waiting for activity restores to reach analytics...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 60,
      message: "Rebuilding activity analytics...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 90,
      message: "Invalidating activity analytics cache...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Activity analytics refresh complete.",
    });
  });

  it("reports recompute analytics progress", async () => {
    const job = createActivityAnalyticsJob("activity-recompute-analytics-refresh");

    await processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting activity analytics refresh...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 60,
      message: "Rebuilding activity analytics...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 90,
      message: "Invalidating activity analytics cache...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Activity analytics refresh complete.",
    });
  });

  it("continues analytics refresh when progress updates fail", async () => {
    const progressError = new Error("redis down");
    const job = createActivityAnalyticsJob("activity-delete-analytics-refresh");
    job.updateProgress = vi.fn().mockRejectedValue(progressError);

    await processActivityDeleteAnalyticsJob(job, fakeDb, workLockPool);

    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    expect(mockCaptureException).toHaveBeenCalledWith(progressError, {
      tags: { activityAnalyticsStep: "updateProgress" },
    });
  });
});
