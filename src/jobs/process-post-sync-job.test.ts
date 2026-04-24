import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostSyncJob } from "./process-post-sync-job.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockUpdateUserMaxHr = vi.fn();
const mockRefreshDedupViews = vi.fn();
const mockLoadProviderPriorityConfig = vi.fn((): unknown => ({ priorities: [] }));
const mockSyncProviderPriorities = vi.fn();
const mockRefitAllParams = vi.fn();

vi.mock("../db/dedup.ts", () => ({
  updateUserMaxHr: (...args: unknown[]) => mockUpdateUserMaxHr(...args),
  refreshDedupViews: (...args: unknown[]) => mockRefreshDedupViews(...args),
}));

vi.mock("../db/provider-priority.ts", () => ({
  loadProviderPriorityConfig: () => mockLoadProviderPriorityConfig(),
  syncProviderPriorities: (...args: unknown[]) => mockSyncProviderPriorities(...args),
}));

vi.mock("../personalization/refit.ts", () => ({
  refitAllParams: (...args: unknown[]) => mockRefitAllParams(...args),
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

describe("processPostSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs only global maintenance operations for a global maintenance job", async () => {
    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockUpdateUserMaxHr).toHaveBeenCalledWith(fakeDb);
    expect(mockLoadProviderPriorityConfig).toHaveBeenCalled();
    expect(mockSyncProviderPriorities).toHaveBeenCalledWith(fakeDb, { priorities: [] });
    expect(mockRefreshDedupViews).toHaveBeenCalledWith(fakeDb);
    expect(mockRefitAllParams).not.toHaveBeenCalled();
  });

  it("runs only per-user refit for a user refit job", async () => {
    await processPostSyncJob(makeUserRefitJob("user-1"), fakeDb);

    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-1");
    expect(mockUpdateUserMaxHr).not.toHaveBeenCalled();
    expect(mockLoadProviderPriorityConfig).not.toHaveBeenCalled();
    expect(mockSyncProviderPriorities).not.toHaveBeenCalled();
    expect(mockRefreshDedupViews).not.toHaveBeenCalled();
  });

  it("continues when updateUserMaxHr fails", async () => {
    mockUpdateUserMaxHr.mockRejectedValueOnce(new Error("max hr failed"));

    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockRefreshDedupViews).toHaveBeenCalled();
    expect(mockSyncProviderPriorities).toHaveBeenCalledWith(fakeDb, { priorities: [] });
    expect(mockRefitAllParams).not.toHaveBeenCalled();
  });

  it("continues when refreshDedupViews fails", async () => {
    mockRefreshDedupViews.mockRejectedValueOnce(new Error("views failed"));

    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockUpdateUserMaxHr).toHaveBeenCalled();
    expect(mockSyncProviderPriorities).toHaveBeenCalledWith(fakeDb, { priorities: [] });
  });

  it("continues when syncProviderPriorities fails", async () => {
    mockSyncProviderPriorities.mockRejectedValueOnce(new Error("priorities failed"));

    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockRefreshDedupViews).toHaveBeenCalled();
    expect(mockUpdateUserMaxHr).toHaveBeenCalled();
  });

  it("continues when refitAllParams fails", async () => {
    mockRefitAllParams.mockRejectedValueOnce(new Error("refit failed"));

    // Should not throw
    await processPostSyncJob(makeUserRefitJob("user-5"), fakeDb);

    expect(mockUpdateUserMaxHr).not.toHaveBeenCalled();
  });

  it("skips syncProviderPriorities when config is null", async () => {
    mockLoadProviderPriorityConfig.mockReturnValueOnce(null);

    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockSyncProviderPriorities).not.toHaveBeenCalledWith(fakeDb, null);
  });

  it("reports errors to Sentry when refreshDedupViews fails", async () => {
    const viewError = new Error("view refresh failed");
    mockRefreshDedupViews.mockRejectedValueOnce(viewError);

    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(viewError, {
      tags: { postSyncStep: "refreshDedupViews" },
    });
  });

  it("reports errors to Sentry when updateUserMaxHr fails", async () => {
    const maxHrError = new Error("max hr failed");
    mockUpdateUserMaxHr.mockRejectedValueOnce(maxHrError);

    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(maxHrError, {
      tags: { postSyncStep: "updateMaxHr" },
    });
  });

  it("reports errors to Sentry when syncProviderPriorities fails", async () => {
    const prioritiesError = new Error("priorities failed");
    mockSyncProviderPriorities.mockRejectedValueOnce(prioritiesError);

    await processPostSyncJob(makeGlobalMaintenanceJob(), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(prioritiesError, {
      tags: { postSyncStep: "syncProviderPriorities" },
    });
  });

  it("reports errors to Sentry when refitAllParams fails", async () => {
    const refitError = new Error("refit failed");
    mockRefitAllParams.mockRejectedValueOnce(refitError);

    await processPostSyncJob(makeUserRefitJob("user-10"), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(refitError, {
      tags: { postSyncStep: "refitParams" },
    });
  });
});
