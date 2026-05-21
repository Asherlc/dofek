import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostSyncJob } from "./process-post-sync-job.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockLoadProviderPriorityConfig = vi.fn((): unknown => ({ priorities: [] }));
const mockSyncProviderPriorities = vi.fn();
const mockRefitAllParams = vi.fn();
const mockInvalidateByPrefix = vi.fn();

vi.mock("../db/provider-priority.ts", () => ({
  loadProviderPriorityConfig: () => mockLoadProviderPriorityConfig(),
  syncProviderPriorities: (...args: unknown[]) => mockSyncProviderPriorities(...args),
}));

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

describe("processPostSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshBodyMeasurements.mockResolvedValue(undefined);
    mockInvalidateByPrefix.mockResolvedValue(undefined);
  });

  it("runs only global maintenance operations for a global maintenance job", async () => {
    const getSensorStore = vi.fn(getFakeSensorStore);

    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockLoadProviderPriorityConfig).toHaveBeenCalled();
    expect(mockSyncProviderPriorities).toHaveBeenCalledWith(fakeDb, { priorities: [] });
    expect(mockRefitAllParams).not.toHaveBeenCalled();
    expect(getSensorStore).not.toHaveBeenCalled();
  });

  it("does not run per-user refits during global post-sync maintenance", async () => {
    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockSyncProviderPriorities).toHaveBeenCalledWith(fakeDb, { priorities: [] });
    expect(mockRefitAllParams).not.toHaveBeenCalled();
  });

  it("runs only per-user refit for a user refit job", async () => {
    await processPostSyncJob(
      makeUserRefitJob("user-1"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-1", fakeSensorStore);
    expect(mockLoadProviderPriorityConfig).not.toHaveBeenCalled();
    expect(mockSyncProviderPriorities).not.toHaveBeenCalled();
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

  it("continues when syncProviderPriorities fails", async () => {
    mockSyncProviderPriorities.mockRejectedValueOnce(new Error("priorities failed"));

    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

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
    );

    expect(mockSyncProviderPriorities).not.toHaveBeenCalled();
  });

  it("skips syncProviderPriorities when config is null", async () => {
    mockLoadProviderPriorityConfig.mockReturnValueOnce(null);

    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockSyncProviderPriorities).not.toHaveBeenCalledWith(fakeDb, null);
  });

  it("reports errors to Sentry when syncProviderPriorities fails", async () => {
    const prioritiesError = new Error("priorities failed");
    mockSyncProviderPriorities.mockRejectedValueOnce(prioritiesError);

    await processPostSyncJob(
      makeGlobalMaintenanceJob(),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockCaptureException).toHaveBeenCalledWith(prioritiesError, {
      tags: { postSyncStep: "syncProviderPriorities" },
    });
  });

  it("reports errors to Sentry when refitAllParams fails", async () => {
    const refitError = new Error("refit failed");
    mockRefitAllParams.mockRejectedValueOnce(refitError);

    await processPostSyncJob(
      makeUserRefitJob("user-10"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockCaptureException).toHaveBeenCalledWith(refitError, {
      tags: { postSyncStep: "refitParams" },
    });
  });

  it("reports errors to Sentry when body measurement refresh fails", async () => {
    const refreshError = new Error("refresh failed");
    refreshBodyMeasurements.mockRejectedValueOnce(refreshError);

    await processPostSyncJob(
      makeUserRefitJob("user-11"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockCaptureException).toHaveBeenCalledWith(refreshError, {
      tags: { postSyncStep: "refreshBodyMeasurements" },
    });
    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-11", fakeSensorStore);
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

  it("reports errors to Sentry when user cache invalidation fails", async () => {
    const cacheError = new Error("cache failed");
    mockInvalidateByPrefix.mockRejectedValueOnce(cacheError);

    await processPostSyncJob(
      makeUserRefitJob("user-13"),
      fakeDb,
      getFakeSensorStore,
      refreshBodyMeasurements,
    );

    expect(mockCaptureException).toHaveBeenCalledWith(cacheError, {
      tags: { postSyncStep: "invalidateUserCache" },
    });
  });
});
