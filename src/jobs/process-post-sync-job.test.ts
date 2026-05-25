import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostSyncJob } from "./process-post-sync-job.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockRefitAllParams = vi.fn();
const mockInvalidateByPrefix = vi.fn();

vi.mock("../personalization/refit.ts", () => ({
  refitAllParams: (...args: unknown[]) => mockRefitAllParams(...args),
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: (...args: unknown[]) => mockInvalidateByPrefix(...args),
  },
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

// Lazy import to respect vi.mock ordering
const { processPostSyncJob } = await import("./process-post-sync-job.ts");

function makeGlobalMaintenanceJob(): PostSyncJob {
  return { data: { type: "global-maintenance" } };
}

function makeUserRefitJob(userId: string): PostSyncJob {
  return { data: { type: "user-refit", userId } };
}

// All DB calls are mocked via vi.mock above, so an empty object satisfies the contract at runtime.
const fakeDb: Parameters<typeof processPostSyncJob>[1] = Object.create(null);
const fakeSensorStore = {
  query: async () => [],
};
const getFakeSensorStore: Parameters<typeof processPostSyncJob>[2] = () => fakeSensorStore;
const refreshBodyMeasurements = vi.fn();
const processSensorDirtyKeys = vi.fn();

describe("processPostSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshBodyMeasurements.mockResolvedValue(undefined);
    processSensorDirtyKeys.mockResolvedValue(0);
    mockInvalidateByPrefix.mockResolvedValue(undefined);
  });

  it("runs only global maintenance operations for a global maintenance job", async () => {
    const getSensorStore = vi.fn(getFakeSensorStore);

    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getSensorStore,
      refreshBodyMeasurements,
      processSensorDirtyKeys,
    );

    expect(processSensorDirtyKeys).toHaveBeenCalledOnce();
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
      processSensorDirtyKeys,
    );

    expect(processSensorDirtyKeys).toHaveBeenCalledOnce();
    expect(mockRefitAllParams).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("runs only per-user refit for a user refit job", async () => {
    await processPostSyncJob(
      makeUserRefitJob("user-1"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
      processSensorDirtyKeys,
    );

    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-1", fakeSensorStore);
  });

  it("refreshes body measurements before refitting and invalidating user caches", async () => {
    await processPostSyncJob(
      makeUserRefitJob("user-1"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
      processSensorDirtyKeys,
    );

    expect(processSensorDirtyKeys).toHaveBeenCalledOnce();
    expect(refreshBodyMeasurements).toHaveBeenCalledOnce();
    expect(processSensorDirtyKeys.mock.invocationCallOrder[0]).toBeLessThan(
      refreshBodyMeasurements.mock.invocationCallOrder[0] ?? 0,
    );
    expect(refreshBodyMeasurements.mock.invocationCallOrder[0]).toBeLessThan(
      mockRefitAllParams.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("drains sensor dirty keys until the backlog is empty", async () => {
    processSensorDirtyKeys
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(0);

    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
      processSensorDirtyKeys,
    );

    expect(processSensorDirtyKeys).toHaveBeenCalledTimes(3);
  });

  it("reports errors to Sentry and aborts when sensor dirty-key processing fails", async () => {
    const dirtyKeyError = new Error("dirty key failed");
    processSensorDirtyKeys.mockRejectedValueOnce(dirtyKeyError);

    await expect(
      processPostSyncJob(
        makeUserRefitJob("user-14"),
        fakeDb,
        getFakeSensorStore,
        refreshBodyMeasurements,
        processSensorDirtyKeys,
      ),
    ).rejects.toThrow(dirtyKeyError);

    expect(mockCaptureException).toHaveBeenCalledWith(dirtyKeyError, {
      tags: { postSyncStep: "processSensorDirtyKeys" },
    });
    expect(refreshBodyMeasurements).not.toHaveBeenCalled();
    expect(mockRefitAllParams).not.toHaveBeenCalled();
  });

  it("continues when refitAllParams fails", async () => {
    mockRefitAllParams.mockRejectedValueOnce(new Error("refit failed"));

    // Should not throw
    await processPostSyncJob(
      makeUserRefitJob("user-5"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
      processSensorDirtyKeys,
    );

    expect(mockCaptureException).toHaveBeenCalled();
  });

  it("reports errors to Sentry when refitAllParams fails", async () => {
    const refitError = new Error("refit failed");
    mockRefitAllParams.mockRejectedValueOnce(refitError);

    await processPostSyncJob(
      makeUserRefitJob("user-10"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
      processSensorDirtyKeys,
    );

    expect(mockCaptureException).toHaveBeenCalledWith(refitError, {
      tags: { postSyncStep: "refitParams" },
    });
  });

  it("reports errors to Sentry and aborts when body measurement refresh fails", async () => {
    const refreshError = new Error("refresh failed");
    refreshBodyMeasurements.mockRejectedValueOnce(refreshError);

    await expect(
      processPostSyncJob(
        makeUserRefitJob("user-11"),
        fakeDb,
        getFakeSensorStore,
        refreshBodyMeasurements,
        processSensorDirtyKeys,
      ),
    ).rejects.toThrow(refreshError);

    expect(mockCaptureException).toHaveBeenCalledWith(refreshError, {
      tags: { postSyncStep: "refreshBodyMeasurements" },
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
      processSensorDirtyKeys,
    );

    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-12:");
    expect(mockRefitAllParams.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateByPrefix.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reports errors to Sentry when user cache invalidation fails", async () => {
    const cacheError = new Error("cache failed");
    mockInvalidateByPrefix.mockRejectedValueOnce(cacheError);

    await processPostSyncJob(
      makeUserRefitJob("user-13"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
      processSensorDirtyKeys,
    );

    expect(mockCaptureException).toHaveBeenCalledWith(cacheError, {
      tags: { postSyncStep: "invalidateUserCache" },
    });
  });
});
