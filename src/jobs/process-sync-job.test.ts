import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncRun } from "../providers/sync-run.ts";
import type { SyncResult } from "../providers/types.ts";

import {
  createMockJob as createBaseMockJob,
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
  mockProviderQueueGetJob,
  mockWithUserWriteFence,
  resetSyncMocks,
} from "./sync-test/test-helpers.ts";

const { processSyncJob } = await import("./process-sync-job.ts");
const runSyncJob = processSyncJob;
function createMockJob(data: Parameters<typeof createBaseMockJob>[0] = {}) {
  const job = createBaseMockJob(data);
  job.id = "coordinator-1";
  return job;
}

describe("process-sync-job", () => {
  beforeEach(resetSyncMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requires a durable coordinator job ID", async () => {
    const job = createMockJob();
    delete job.id;
    await expect(runSyncJob(job, mockDb)).rejects.toThrow(
      "Shared sync coordination requires a BullMQ job ID",
    );
  });

  it("requires the coordinator's actual BullMQ worker token", async () => {
    const job = { ...createMockJob(), token: undefined };
    await expect(runSyncJob(job, mockDb)).rejects.toThrow(
      "Shared sync coordination requires a BullMQ worker token",
    );
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
  });

  it.each(["sinceIso", "untilIso", "requestedAtIso"] as const)(
    "resolves and persists a partially anchored request missing %s",
    async (missing) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-21T06:30:00.000Z"));
      mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
      const bounds = {
        sinceIso: "2026-09-20T00:00:00.000Z",
        untilIso: "2026-09-21T23:59:59.999Z",
        requestedAtIso: "2026-09-21T06:30:00.000Z",
      };
      const job = createMockJob({ sinceDays: 1, ...bounds, [missing]: undefined });
      const expectedBounds = {
        ...bounds,
        untilIso: missing === "untilIso" ? bounds.requestedAtIso : bounds.untilIso,
      };
      await runSyncJob(job, mockDb);
      expect(job.updateData).toHaveBeenCalledOnce();
      expect(job.updateData).toHaveBeenCalledWith(expect.objectContaining(expectedBounds));
      expect(mockProviderQueueAdd).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining(expectedBounds),
        expect.any(Object),
      );
    },
  );

  it("uses fully persisted bounds on retry without rewriting them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T15:00:00.000Z"));
    mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
    const bounds = {
      sinceIso: "2026-09-20T00:00:00.000Z",
      untilIso: "2026-09-21T23:59:59.999Z",
      requestedAtIso: "2026-09-21T06:30:00.000Z",
    };
    const job = createMockJob({ sinceDays: 1, ...bounds });
    job.attemptsMade = 1;
    await runSyncJob(job, mockDb);
    expect(job.updateData).not.toHaveBeenCalled();
    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining(bounds),
      expect.any(Object),
    );
  });

  it("persists absolute bounds before dispatch and preserves them on a later retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T06:30:00.000Z"));
    mockGetEnabledSyncProviders.mockReturnValue([
      createMockProvider({ id: "a" }),
      createMockProvider({ id: "b" }),
    ]);
    const error = new Error("Redis enqueue unavailable");
    mockProviderQueueAdd
      .mockResolvedValueOnce({ getState: vi.fn().mockResolvedValue("waiting"), remove: vi.fn() })
      .mockRejectedValueOnce(error);
    const job = createMockJob({ origin: "scheduled", sinceDays: 1 });
    await expect(runSyncJob(job, mockDb)).rejects.toBe(error);
    const firstWindow = { sinceIso: job.data.sinceIso, untilIso: job.data.untilIso };
    expect(firstWindow).toEqual({
      sinceIso: "2026-09-20T00:00:00.000Z",
      untilIso: "2026-09-21T23:59:59.999Z",
    });
    const childId = z
      .object({ jobId: z.string() })
      .parse(mockProviderQueueAdd.mock.calls[0]?.[2]).jobId;
    job.getDependencies.mockResolvedValue({ processed: { [`bull:sync-a:${childId}`]: null } });
    mockProviderQueueAdd.mockClear();
    mockProviderQueueGetJob.mockResolvedValue(undefined); // Completed child has been removed by retention.
    vi.setSystemTime(new Date("2026-09-22T18:00:00.000Z"));
    await runSyncJob(job, mockDb);
    expect(mockProviderQueueAdd).toHaveBeenCalledOnce();
    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({
        providerId: "b",
        ...firstWindow,
        requestedAtIso: "2026-09-21T06:30:00.000Z",
      }),
      expect.any(Object),
    );
    expect(job.moveToWaitingChildren).toHaveBeenCalledWith("sync-token");
  });

  it("recovers a lost enqueue acknowledgement after the completed child is pruned", async () => {
    const child = { getState: vi.fn().mockResolvedValue("completed"), remove: vi.fn() };
    const queuedChildren = new Map<string, typeof child>();
    mockProviderQueueAdd.mockImplementation(
      async (_name: unknown, _data: unknown, options: unknown) => {
        queuedChildren.set(z.object({ jobId: z.string() }).parse(options).jobId, child);
        throw new Error("Enqueue acknowledgement lost");
      },
    );
    mockProviderQueueGetJob.mockImplementation(async (id: unknown) =>
      queuedChildren.get(String(id)),
    );
    mockGetEnabledSyncProviders.mockReturnValue([
      createMockProvider({ id: "a" }),
      createMockProvider({ id: "b" }),
    ]);
    const job = createMockJob({
      requestedAtIso: "2026-09-21T06:30:00.000Z",
      sinceIso: "2026-09-20T00:00:00.000Z",
      untilIso: "2026-09-21T23:59:59.999Z",
    });
    await expect(runSyncJob(job, mockDb)).rejects.toThrow("Enqueue acknowledgement lost");
    expect(mockProviderQueueAdd).toHaveBeenCalledTimes(1);
    const childId = [...queuedChildren.keys()][0];
    queuedChildren.clear();
    job.getDependencies.mockResolvedValue({ processed: { [`bull:sync-a:${childId}`]: null } });
    mockProviderQueueAdd.mockResolvedValue(child);
    await runSyncJob(job, mockDb);
    expect(mockProviderQueueAdd).toHaveBeenCalledTimes(2);
    expect(child.remove).not.toHaveBeenCalled();
    expect(job.moveToWaitingChildren).toHaveBeenCalledWith("sync-token");
  });

  it("moves the coordinator to waiting-children without treating it as a failure", async () => {
    const job = createMockJob();
    job.moveToWaitingChildren.mockResolvedValue(true);
    await expect(runSyncJob(job, mockDb)).rejects.toMatchObject({ name: "WaitingChildrenError" });
  });

  it.each(["processed", "ignored", "unprocessed", "failed"])(
    "reuses a %s dependency when the child queue record is gone",
    async (state) => {
      mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
      const job = createMockJob();
      await runSyncJob(job, mockDb);
      const childId = z
        .object({ jobId: z.string() })
        .parse(mockProviderQueueAdd.mock.calls[0]?.[2]).jobId;
      const childKey = `bull:provider:${childId}`;
      job.getDependencies.mockResolvedValue({
        [state]: state === "processed" || state === "ignored" ? { [childKey]: null } : [childKey],
      });
      mockProviderQueueAdd.mockClear();
      mockProviderQueueGetJob.mockResolvedValue(undefined);
      await runSyncJob(job, mockDb);
      expect(mockProviderQueueAdd).not.toHaveBeenCalled();
    },
  );

  it("checks cancellation after acquiring the coordinator write fence", async () => {
    let releaseFence!: () => void;
    let enteredFence!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFence = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    mockWithUserWriteFence.mockImplementationOnce(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => {
        enteredFence();
        await gate;
        return operation(database);
      },
    );
    mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
    const controller = new AbortController();
    const reason = new DOMException("Coordinator cancelled", "AbortError");
    const result = runSyncJob(createMockJob(), mockDb, controller.signal);
    await entered;
    controller.abort(reason);
    releaseFence();
    await expect(result).rejects.toBe(reason);
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
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

    await runSyncJob(createMockJob({ providerId: "test-provider" }), mockDb, controller.signal);

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

    await runSyncJob(createMockJob({ providerId: "test-provider" }), mockDb, controller.signal);

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

  it("dispatches a dedicated job for every eligible provider", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);

    const job = createMockJob();
    const progress: object[] = [];
    job.updateProgress.mockImplementation(async (value: object) => {
      progress.push(structuredClone(value));
    });
    await runSyncJob(job, mockDb);

    expect(progress).toEqual([
      { providers: { a: { status: "pending" }, b: { status: "pending" } }, percentage: 0 },
      {
        providers: {
          a: { status: "done", message: "Provider sync queued" },
          b: { status: "pending" },
        },
        percentage: 50,
      },
      {
        providers: {
          a: { status: "done", message: "Provider sync queued" },
          b: { status: "done", message: "Provider sync queued" },
        },
        percentage: 100,
      },
    ]);
    expect(mockProviderQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockProviderQueueAdd).toHaveBeenNthCalledWith(
      1,
      "sync",
      expect.objectContaining({
        providerId: "a",
        sinceIso: expect.any(String),
        untilIso: expect.any(String),
      }),
      expect.objectContaining({
        attempts: 288,
        parent: { id: "coordinator-1", queue: "bull:sync" },
        ignoreDependencyOnFailure: true,
      }),
    );
    expect(mockProviderQueueAdd).toHaveBeenNthCalledWith(
      2,
      "sync",
      expect.objectContaining({
        providerId: "b",
        sinceIso: expect.any(String),
        untilIso: expect.any(String),
      }),
      expect.objectContaining({
        attempts: 288,
        parent: { id: "coordinator-1", queue: "bull:sync" },
        ignoreDependencyOnFailure: true,
      }),
    );
    expect(providerA.sync).not.toHaveBeenCalled();
    expect(providerB.sync).not.toHaveBeenCalled();
  });

  it("dispatches only the enabled provider list", async () => {
    const valid = createMockProvider({ id: "valid", name: "Valid" });
    mockGetEnabledSyncProviders.mockReturnValue([valid]);

    await runSyncJob(createMockJob(), mockDb);

    expect(mockProviderQueueAdd).toHaveBeenCalledOnce();
    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({ providerId: "valid" }),
      expect.any(Object),
    );
  });

  it("syncs only the specified provider when providerId is given", async () => {
    const providerA = createMockProvider({ id: "a", name: "Provider A" });
    const providerB = createMockProvider({ id: "b", name: "Provider B" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);
    mockGetProvider.mockReturnValue(providerB);

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

  it("enqueues debounced global maintenance and per-user refit after sync", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);

    await runSyncJob(createMockJob({ providerId: "test-provider" }), mockDb);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    expect(mockCaptureException).not.toHaveBeenCalled();
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
    mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
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

    const syncPromise = runSyncJob(
      createMockJob({ providerId: "test-provider" }),
      mockDb,
      controller.signal,
    );
    await fenceEntered;
    controller.abort(reason);
    releaseFence();

    await expect(syncPromise).rejects.toBe(reason);
    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
  });

  it("continues when global post-sync enqueue fails", async () => {
    const enqueueError = new Error("queue gone");
    mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
    mockEnqueueDebouncedPostSyncMaintenance.mockRejectedValue(enqueueError);

    // Should not throw
    await runSyncJob(createMockJob({ providerId: "test-provider" }), mockDb);

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
    mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
    mockEnqueueDebouncedUserRefit.mockRejectedValue(enqueueError);

    await runSyncJob(createMockJob({ providerId: "test-provider" }), mockDb);

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
    mockGetEnabledSyncProviders.mockReturnValue([createMockProvider()]);
    mockEnqueueDebouncedUserRefit.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(
      runSyncJob(createMockJob({ providerId: "test-provider" }), mockDb, controller.signal),
    ).rejects.toBe(reason);

    expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
