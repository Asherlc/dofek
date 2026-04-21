import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostSyncJob } from "./process-post-sync-job.ts";

const mockCaptureException = vi.fn();
vi.mock("dofek/telemetry", () => ({
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

function makeJob(userId: string): PostSyncJob {
  return { data: { userId } };
}

// All DB calls are mocked via vi.mock above, so an empty object satisfies the contract at runtime.
const fakeDb: Parameters<typeof processPostSyncJob>[1] = Object.create(null);

describe("processPostSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs all four post-sync operations", async () => {
    await processPostSyncJob(makeJob("user-1"), fakeDb);

    expect(mockUpdateUserMaxHr).toHaveBeenCalledWith(fakeDb);
    expect(mockLoadProviderPriorityConfig).toHaveBeenCalled();
    expect(mockSyncProviderPriorities).toHaveBeenCalledWith(fakeDb, { priorities: [] });
    expect(mockRefreshDedupViews).toHaveBeenCalledWith(fakeDb);
    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-1");
  });

  it("continues when updateUserMaxHr fails", async () => {
    mockUpdateUserMaxHr.mockRejectedValueOnce(new Error("max hr failed"));

    await processPostSyncJob(makeJob("user-2"), fakeDb);

    // Other operations still called
    expect(mockRefreshDedupViews).toHaveBeenCalled();
    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-2");
  });

  it("continues when refreshDedupViews fails", async () => {
    mockRefreshDedupViews.mockRejectedValueOnce(new Error("views failed"));

    await processPostSyncJob(makeJob("user-3"), fakeDb);

    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-3");
  });

  it("continues when syncProviderPriorities fails", async () => {
    mockSyncProviderPriorities.mockRejectedValueOnce(new Error("priorities failed"));

    await processPostSyncJob(makeJob("user-4"), fakeDb);

    expect(mockRefreshDedupViews).toHaveBeenCalled();
    expect(mockRefitAllParams).toHaveBeenCalledWith(fakeDb, "user-4");
  });

  it("continues when refitAllParams fails", async () => {
    mockRefitAllParams.mockRejectedValueOnce(new Error("refit failed"));

    // Should not throw
    await processPostSyncJob(makeJob("user-5"), fakeDb);

    expect(mockUpdateUserMaxHr).toHaveBeenCalled();
  });

  it("skips syncProviderPriorities when config is null", async () => {
    mockLoadProviderPriorityConfig.mockReturnValueOnce(null);

    await processPostSyncJob(makeJob("user-6"), fakeDb);

    expect(mockSyncProviderPriorities).not.toHaveBeenCalledWith(fakeDb, null);
  });

  it("reports errors to telemetry when refreshDedupViews fails", async () => {
    const viewError = new Error("view refresh failed");
    mockRefreshDedupViews.mockRejectedValueOnce(viewError);

    await processPostSyncJob(makeJob("user-7"), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(viewError, {
      tags: { postSyncStep: "refreshDedupViews" },
    });
  });

  it("reports errors to telemetry when updateUserMaxHr fails", async () => {
    const maxHrError = new Error("max hr failed");
    mockUpdateUserMaxHr.mockRejectedValueOnce(maxHrError);

    await processPostSyncJob(makeJob("user-8"), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(maxHrError, {
      tags: { postSyncStep: "updateMaxHr" },
    });
  });

  it("reports errors to telemetry when syncProviderPriorities fails", async () => {
    const prioritiesError = new Error("priorities failed");
    mockSyncProviderPriorities.mockRejectedValueOnce(prioritiesError);

    await processPostSyncJob(makeJob("user-9"), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(prioritiesError, {
      tags: { postSyncStep: "syncProviderPriorities" },
    });
  });

  it("reports errors to telemetry when refitAllParams fails", async () => {
    const refitError = new Error("refit failed");
    mockRefitAllParams.mockRejectedValueOnce(refitError);

    await processPostSyncJob(makeJob("user-10"), fakeDb);

    expect(mockCaptureException).toHaveBeenCalledWith(refitError, {
      tags: { postSyncStep: "refitParams" },
    });
  });
});
