import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostSyncJob } from "./process-post-sync-job.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockRefitAllParams = vi.fn();
const mockInvalidateByPrefix = vi.fn();
const mockAccountErasureAllowsQueuedUserWork = vi.fn();

vi.mock("./account-erasure-work-guard.ts", () => ({
  accountErasureAllowsQueuedUserWork: (database: unknown, userId: string, workKind: string) =>
    mockAccountErasureAllowsQueuedUserWork(database, userId, workKind),
}));

vi.mock("../personalization/refit.ts", () => ({
  refitAllParams: (...args: unknown[]) => mockRefitAllParams(...args),
}));

vi.mock("../lib/cache.ts", () => ({
  invalidateAllUserQueries: (userId: string) => mockInvalidateByPrefix(`${userId}:`),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Lazy import to respect vi.mock ordering
const { processPostSyncJob } = await import("./process-post-sync-job.ts");

function makeGlobalMaintenanceJob(): PostSyncJob {
  return {
    data: { type: "global-maintenance" },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function makeUserRefitJob(userId: string): PostSyncJob {
  return {
    data: { type: "user-refit", userId },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

// All DB calls are mocked via vi.mock above, so an empty object satisfies the contract at runtime.
const fakeDb: Parameters<typeof processPostSyncJob>[1] = Object.create(null);
const fakeSensorStore = {
  query: async () => [],
};
const getFakeSensorStore: Parameters<typeof processPostSyncJob>[2] = () => fakeSensorStore;
const refreshBodyMeasurements = vi.fn();

describe("processPostSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshBodyMeasurements.mockResolvedValue(undefined);
    mockInvalidateByPrefix.mockResolvedValue(undefined);
    mockAccountErasureAllowsQueuedUserWork.mockResolvedValue(true);
  });

  it("runs only global maintenance operations for a global maintenance job", async () => {
    const getSensorStore = vi.fn(getFakeSensorStore);

    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockRefitAllParams).not.toHaveBeenCalled();
    expect(getSensorStore).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("does not run per-user refits during global post-sync maintenance", async () => {
    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockRefitAllParams).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("reports global maintenance progress", async () => {
    const job = makeGlobalMaintenanceJob();

    await processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting global post-sync maintenance...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Global post-sync maintenance complete.",
    });
  });

  it("runs only per-user refit for a user refit job", async () => {
    await processPostSyncJob(
      makeUserRefitJob("user-1"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-1", fakeSensorStore);
  });

  it("discards a refit when deletion activates after dequeue but before its first side effect", async () => {
    mockAccountErasureAllowsQueuedUserWork.mockResolvedValueOnce(false);

    await processPostSyncJob(
      makeUserRefitJob("user-1"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockAccountErasureAllowsQueuedUserWork).toHaveBeenCalledWith(
      fakeDb,
      "user-1",
      "post-sync body measurement refresh",
    );
    expect(refreshBodyMeasurements).not.toHaveBeenCalled();
    expect(mockRefitAllParams).not.toHaveBeenCalled();
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
  });

  it("reports per-user refit progress", async () => {
    const job = makeUserRefitJob("user-1");

    await processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting post-sync refit...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 20,
      message: "Refreshing body measurements...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 45,
      message: "Refitting personalized parameters...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 75,
      message: "Invalidating user cache...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Post-sync refit complete.",
    });
  });

  it("continues post-sync work when progress updates fail", async () => {
    const progressError = new Error("redis down");
    const job = makeUserRefitJob("user-1");
    job.updateProgress = vi.fn().mockRejectedValue(progressError);

    await processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements);

    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-1", fakeSensorStore);
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    expect(mockCaptureException).toHaveBeenCalledWith(progressError, {
      tags: { postSyncStep: "updateProgress" },
    });
  });

  it("refreshes body measurements before refitting and invalidating user caches", async () => {
    await processPostSyncJob(
      makeUserRefitJob("user-1"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(refreshBodyMeasurements).toHaveBeenCalledOnce();
    expect(refreshBodyMeasurements.mock.invocationCallOrder[0]).toBeLessThan(
      mockRefitAllParams.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reports and rejects when personalized parameter refitting fails", async () => {
    const refitError = new Error("refit failed");
    const job = makeUserRefitJob("user-10");
    mockRefitAllParams.mockRejectedValueOnce(refitError);

    await expect(
      processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements),
    ).rejects.toBe(refitError);

    expect(mockCaptureException).toHaveBeenCalledWith(refitError, {
      tags: { postSyncStep: "refitParams" },
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 45,
      message: "Personalized parameter refit failed; retry required.",
    });
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    expect(job.updateProgress).not.toHaveBeenCalledWith({
      percentage: 100,
      message: "Post-sync refit complete.",
    });
  });

  it("reports errors to Sentry and aborts when body measurement refresh fails", async () => {
    const refreshError = new Error("refresh failed");
    const job = makeUserRefitJob("user-11");
    refreshBodyMeasurements.mockRejectedValueOnce(refreshError);

    await expect(
      processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements),
    ).rejects.toBe(refreshError);

    expect(mockCaptureException).toHaveBeenCalledWith(refreshError, {
      tags: { postSyncStep: "refreshBodyMeasurements" },
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 20,
      message: "Body measurement refresh failed; retry required.",
    });
    expect(mockRefitAllParams).not.toHaveBeenCalled();
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
  });

  it("invalidates the user cache after refitting", async () => {
    await processPostSyncJob(
      makeUserRefitJob("user-12"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-12:");
    expect(mockRefitAllParams.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateByPrefix.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reports and rejects when user cache invalidation fails", async () => {
    const cacheError = new Error("cache failed");
    const job = makeUserRefitJob("user-13");
    mockInvalidateByPrefix.mockRejectedValueOnce(cacheError);

    await expect(
      processPostSyncJob(job, fakeDb, getFakeSensorStore, refreshBodyMeasurements),
    ).rejects.toBe(cacheError);

    expect(mockCaptureException).toHaveBeenCalledWith(cacheError, {
      tags: { postSyncStep: "invalidateUserCache" },
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 75,
      message: "User cache invalidation failed; retry required.",
    });
    expect(job.updateProgress).not.toHaveBeenCalledWith({
      percentage: 100,
      message: "Post-sync refit complete.",
    });
  });
});
