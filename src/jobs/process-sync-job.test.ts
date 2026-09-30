import { ProviderServiceUnavailableError } from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRun } from "../providers/sync-run.ts";
import type { SyncResult } from "../providers/types.ts";

import {
  createMockJob,
  createMockProvider,
  mockCaptureException,
  mockDb,
  mockEnqueueDebouncedPostSyncMaintenance,
  mockEnqueueDebouncedUserRefit,
  mockGetEnabledSyncProviders,
  mockGetProvider,
  mockInvalidateAllUserQueries,
  mockIsSyncEligibleProvider,
  mockLoggerError,
  mockLogSync,
  mockProviderQueueAdd,
  mockWithUserWriteFence,
  resetSyncMocks,
} from "./sync-test/test-helpers.ts";

const { processSyncJob } = await import("./process-sync-job.ts");
const runSyncJob = processSyncJob;

describe("process-sync-job", () => {
  beforeEach(resetSyncMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects a pre-aborted sync before provider or post-sync work", async () => {
    const provider = createMockProvider();
    mockGetEnabledSyncProviders.mockReturnValue([provider]);
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled before start", "AbortError");
    controller.abort(reason);

    await expect(runSyncJob(createMockJob(), mockDb, controller.signal)).rejects.toBe(reason);

    expect(provider.sync).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
  });

  it("logs a cancel SyncResult with no commits and skips post-sync maintenance", async () => {
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled during sync", "AbortError");
    const provider = createMockProvider({
      sync: vi.fn(async () => {
        controller.abort(reason);
        return {
          provider: "test-provider",
          recordsSynced: 0,
          errors: [{ message: "Sync cancelled", cause: reason }],
          duration: 1,
        };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb, controller.signal);

    expect(mockInvalidateAllUserQueries).not.toHaveBeenCalled();
    expect(mockLogSync).toHaveBeenCalledOnce();
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
  });

  it("invalidates and logs when a cancel SyncResult includes committed records", async () => {
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled after commits", "AbortError");
    const provider = createMockProvider({
      sync: vi.fn(async () => {
        controller.abort(reason);
        return {
          provider: "test-provider",
          recordsSynced: 3,
          errors: [{ message: "Sync cancelled", cause: reason }],
          duration: 1,
        };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(createMockJob(), mockDb, controller.signal);

    expect(mockInvalidateAllUserQueries).toHaveBeenCalledOnce();
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledWith("user-1");
    expect(mockLogSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "test-provider",
        errorMessage: "Sync cancelled",
        recordCount: 3,
      }),
    );
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
  });

  it("skips post-sync work when cancellation arrives without a provider", async () => {
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled before post-sync", "AbortError");
    const job = createMockJob();
    job.updateProgress.mockImplementationOnce(async () => {
      controller.abort(reason);
    });

    await expect(runSyncJob(job, mockDb, controller.signal)).rejects.toBe(reason);

    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
  });

  it("syncs all valid providers when no providerId specified", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);

    await runSyncJob(createMockJob(), mockDb);

    expect(providerA.sync).toHaveBeenCalledOnce();
    expect(providerB.sync).toHaveBeenCalledOnce();
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledTimes(2);
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("filters out invalid providers", async () => {
    const valid = createMockProvider({ id: "valid", name: "Valid" });
    mockGetEnabledSyncProviders.mockReturnValue([valid]);

    await runSyncJob(createMockJob(), mockDb);

    expect(valid.sync).toHaveBeenCalledOnce();
  });

  it("syncs only the specified provider when providerId is given", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);

    await runSyncJob(createMockJob({ providerId: "b" }), mockDb);

    expect(providerA.sync).not.toHaveBeenCalled();
    expect(providerB.sync).toHaveBeenCalledOnce();
  });

  it("throws for unknown providerId", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA]);

    await expect(runSyncJob(createMockJob({ providerId: "nonexistent" }), mockDb)).rejects.toThrow(
      "Unknown provider: nonexistent",
    );
  });

  it("skips import-only providers when enqueued by id", async () => {
    mockGetProvider.mockReturnValue({ id: "strong-csv", importOnly: true });
    mockIsSyncEligibleProvider.mockReturnValue(false);

    const job = createMockJob({ providerId: "strong-csv" });
    await runSyncJob(job, mockDb);

    expect(job.updateProgress).toHaveBeenCalledWith({
      providers: { "strong-csv": { status: "done", message: "Skipped file-import provider" } },
      percentage: 100,
    });
  });

  it.each([0, 287])(
    "finishes other providers and post-sync work before propagating OpenBeta failure on attempt %s",
    async (attemptsMade) => {
      const error = new ProviderServiceUnavailableError({
        providerId: "openbeta",
        statusCode: 504,
        message: "upstream unavailable",
        responseBody: "unavailable",
      });
      const laterProvider = createMockProvider({ id: "wahoo", name: "Wahoo" });
      mockGetEnabledSyncProviders.mockReturnValue([
        createMockProvider({
          id: "openbeta",
          name: "OpenBeta",
          sync: vi.fn().mockRejectedValue(error),
        }),
        laterProvider,
      ]);
      const job = createMockJob();
      job.attemptsMade = attemptsMade;

      await expect(runSyncJob(job, mockDb)).rejects.toBe(error);

      expect(laterProvider.sync).toHaveBeenCalledOnce();
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ providerId: "wahoo", status: "success" }),
      );
      expect(job.updateProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providers: expect.objectContaining({ wahoo: { status: "done", message: "5 synced" } }),
        }),
      );
      expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
      expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    },
  );

  it("enqueues debounced global maintenance and per-user refit after sync", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
  });

  it("enqueues a continuation job and skips post-sync when sync returns continued", async () => {
    const continuationCheckpoint = { phase: "api", apiStepIndex: 2 };
    const provider = createMockProvider({
      id: "whoop",
      name: "WHOOP",
      sync: vi.fn().mockImplementation(async (run: SyncRun): Promise<SyncResult> => {
        await run.options.enqueueSyncContinuation?.(continuationCheckpoint);
        return {
          provider: "whoop",
          recordsSynced: 4,
          errors: [],
          duration: 12,
          continued: true,
        };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ providerId: "whoop" });
    await runSyncJob(job, mockDb);

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({
        providerId: "whoop",
        sinceIso: expect.any(String),
        untilIso: expect.any(String),
        checkpoint: continuationCheckpoint,
      }),
      expect.any(Object),
    );
    expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { whoop: { status: "running", message: "4 synced so far" } },
      }),
    );
  });

  it("does not enqueue a user refit after cancellation while waiting for the write fence", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([]);
    let releaseFence!: () => void;
    let markFenceEntered!: () => void;
    const fenceEntered = new Promise<void>((resolve) => {
      markFenceEntered = resolve;
    });
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    mockWithUserWriteFence.mockImplementationOnce(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => {
        markFenceEntered();
        await fenceGate;
        return operation(database);
      },
    );
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled before user refit", "AbortError");

    const syncPromise = runSyncJob(createMockJob(), mockDb, controller.signal);
    await fenceEntered;
    controller.abort(reason);
    releaseFence();

    await expect(syncPromise).rejects.toBe(reason);
    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
  });

  it("continues when global post-sync enqueue fails", async () => {
    const enqueueError = new Error("queue gone");
    mockGetEnabledSyncProviders.mockReturnValue([]);
    mockEnqueueDebouncedPostSyncMaintenance.mockRejectedValue(enqueueError);

    // Should not throw
    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue global post-sync maintenance"),
    );
    expect(mockCaptureException).toHaveBeenCalledWith(enqueueError, {
      tags: { phase: "post-sync-global-maintenance-enqueue" },
    });
  });

  it("continues when per-user refit enqueue fails", async () => {
    const enqueueError = new Error("queue gone");
    mockGetEnabledSyncProviders.mockReturnValue([]);
    mockEnqueueDebouncedUserRefit.mockRejectedValue(enqueueError);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue user refit"),
    );
    expect(mockCaptureException).toHaveBeenCalledWith(enqueueError, {
      tags: { phase: "post-sync-user-refit-enqueue" },
    });
  });

  it("does not swallow cancellation during the final post-sync enqueue", async () => {
    const controller = new AbortController();
    const reason = new DOMException("queue cancelled during post-sync", "AbortError");
    mockGetEnabledSyncProviders.mockReturnValue([]);
    mockEnqueueDebouncedUserRefit.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(runSyncJob(createMockJob(), mockDb, controller.signal)).rejects.toBe(reason);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
