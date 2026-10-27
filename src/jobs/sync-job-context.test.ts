import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import type { SyncRun } from "../providers/sync-run.ts";
import { SyncWindow } from "../providers/sync-window.ts";
import type { SyncResult } from "../providers/types.ts";

import {
  createMockJob,
  createMockProvider,
  type MockJob,
  mockCaptureException,
  mockDb,
  mockGetEnabledSyncProviders,
  mockLoggerWarn,
  mockProviderQueueAdd,
  mockWithUserWriteFence,
  processingOperationId,
  resetSyncMocks,
} from "./sync-test/test-helpers.ts";

const { SyncJobContext } = await import("./sync-job-context.ts");
async function runSyncJob(job: MockJob, db: SyncDatabase, signal?: AbortSignal) {
  const context = await SyncJobContext.create(job, db, signal);
  const providers = mockGetEnabledSyncProviders().filter(
    (provider) => !job.data.providerId || provider.id === job.data.providerId,
  );
  await context.initializeProviders(providers);
  for (const provider of providers) {
    context.providerStatus[provider.id] = { status: "running" };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });
    const result = await provider.sync(context.createRun(provider));
    context.completedCount++;
    context.providerStatus[provider.id] = {
      status: "done",
      message: `${result.recordsSynced} synced`,
    };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });
  }
}

describe("sync-job-context", () => {
  beforeEach(resetSyncMocks);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses with native Node TypeScript stripping", () => {
    const source = readFileSync(new URL("./sync-job-context.ts", import.meta.url), "utf8");
    expect(() => stripTypeScriptTypes(source, { mode: "strip" })).not.toThrow();
  });

  it("reports a rejected background progress write with provider context", async () => {
    const error = new Error("Redis progress write failed");
    const job = createMockJob();
    const context = await SyncJobContext.create(job, mockDb);
    const provider = createMockProvider({ id: "openbeta" });
    const rejectedWrite = Promise.reject(error);
    const observedRejection = rejectedWrite.catch((observedError) => {
      expect(observedError).toBe(error);
    });
    job.updateProgress.mockReturnValueOnce(rejectedWrite);
    context.createRun(provider).options.onProgress?.(25, "Loading");
    await observedRejection;
    await Promise.resolve();
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { provider: "openbeta", syncStep: "updateProgress" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[worker] Failed to update sync progress for openbeta: Error: Redis progress write failed",
    );
  });

  it("passes cancellation and scheduling context to each provider sync run", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-09-21T06:30:00.000Z");
    vi.setSystemTime(startedAt);
    const signal = new AbortController().signal;
    const provider = createMockProvider({
      sync: vi.fn().mockResolvedValue({
        provider: "test-provider",
        recordsSynced: 0,
        errors: [],
        duration: 1,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({ origin: "scheduled", sinceDays: 1 });
    await runSyncJob(job, mockDb, signal);

    expect(provider.sync).toHaveBeenCalledOnce();
    expect(job.data.requestedAtIso).toBe(startedAt.toISOString());
    const run = vi.mocked(provider.sync).mock.calls[0]?.[0];
    expect(run?.options).toMatchObject({
      origin: "scheduled",
      relativeWindow: true,
      requestedAt: startedAt,
      signal,
    });
  });

  it("reuses a scheduled request anchor when a retry starts on a later UTC date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T18:00:00.000Z"));
    const requestedAt = new Date("2026-09-21T06:30:00.000Z");
    const provider = createMockProvider({
      sync: vi.fn().mockResolvedValue({
        provider: "test-provider",
        recordsSynced: 0,
        errors: [],
        duration: 1,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(
      createMockJob({
        origin: "scheduled",
        requestedAtIso: requestedAt.toISOString(),
        sinceDays: 1,
      }),
      mockDb,
    );

    expect(provider.sync).toHaveBeenCalledOnce();
    const run = vi.mocked(provider.sync).mock.calls[0]?.[0];
    expect(run?.options.requestedAt).toEqual(requestedAt);
    expect(run?.window.sinceIso).toBe("2026-09-20T00:00:00.000Z");
    expect(run?.window.untilIso).toBe("2026-09-21T23:59:59.999Z");
  });

  it("keeps a day lookback with a fixed historical end literal", async () => {
    const provider = createMockProvider({
      sync: vi.fn().mockResolvedValue({
        provider: "test-provider",
        recordsSynced: 0,
        errors: [],
        duration: 1,
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    await runSyncJob(
      createMockJob({
        origin: "manual",
        requestedAtIso: "2026-09-21T06:30:00.000Z",
        sinceDays: 7,
        sinceIso: "2026-06-10T00:00:00.000Z",
        untilIso: "2026-06-17T23:59:59.999Z",
        targetRefreshWindow: {
          type: "range",
          sinceIso: "2026-06-10T00:00:00.000Z",
          untilIso: "2026-06-17T23:59:59.999Z",
        },
      }),
      mockDb,
    );

    expect(provider.sync).toHaveBeenCalledOnce();
    const run = vi.mocked(provider.sync).mock.calls[0]?.[0];
    expect(run?.options.relativeWindow).toBe(false);
    expect(run?.window.sinceIso).toBe("2026-06-10T00:00:00.000Z");
    expect(run?.window.untilIso).toBe("2026-06-17T23:59:59.999Z");
  });

  it("does not enqueue a continuation after cancellation while waiting for the write fence", async () => {
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
    const reason = new DOMException("queue cancelled before continuation", "AbortError");
    const provider = createMockProvider({
      id: "whoop",
      name: "WHOOP",
      sync: vi.fn().mockImplementation(async (run: SyncRun): Promise<SyncResult> => {
        await run.options.enqueueSyncContinuation?.({ phase: "api", apiStepIndex: 2 });
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

    const syncPromise = runSyncJob(
      createMockJob({ providerId: "whoop" }),
      mockDb,
      controller.signal,
    );
    await fenceEntered;
    controller.abort(reason);
    releaseFence();

    await expect(syncPromise).rejects.toBe(reason);
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
  });

  it("relays within-provider progress to job.updateProgress with correct percentage", async () => {
    // Provider that calls the onProgress callback during sync
    const provider = createMockProvider({
      id: "test",
      name: "Test",
      sync: vi.fn().mockImplementation(async (run: SyncRun) => {
        run.options?.onProgress?.(50, "5/10 activities");
        return { provider: "test", recordsSynced: 10, errors: [], duration: 100 };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    await runSyncJob(job, mockDb);

    // With 1 provider: within-provider 50% should yield 50% overall
    const withinProviderSnapshot = progressSnapshots.find(
      (s) => "percentage" in s && s.percentage === 50,
    );
    expect(withinProviderSnapshot).toBeDefined();
    expect(withinProviderSnapshot).toMatchObject({
      providers: { test: { status: "running", message: "5/10 activities" } },
      percentage: 50,
    });
  });

  it("computes percentage across multiple providers", async () => {
    const providerA = createMockProvider({ id: "a", name: "A" });
    const providerB = createMockProvider({ id: "b", name: "B" });
    mockGetEnabledSyncProviders.mockReturnValue([providerA, providerB]);

    const progressSnapshots: Array<Record<string, unknown>> = [];
    const job = createMockJob();
    job.updateProgress.mockImplementation((data: Record<string, unknown>) => {
      progressSnapshots.push(structuredClone(data));
      return Promise.resolve();
    });

    await runSyncJob(job, mockDb);

    // After first provider completes: 50%, after second: 100%
    const percentages = progressSnapshots.map((s) =>
      "percentage" in s ? s.percentage : undefined,
    );
    expect(percentages[percentages.length - 1]).toBe(100);
    // After first provider done, before second starts running
    expect(percentages).toContain(50);
  });

  it("computes since date from sinceDays", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const now = new Date("2026-06-18T15:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());

    await runSyncJob(createMockJob({ sinceDays: 30 }), mockDb);

    const expectedWindow = SyncWindow.lastDays(30, { now });
    expect(provider.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mockDb,
        window: expectedWindow,
        options: expect.objectContaining({
          onProgress: expect.any(Function),
          userId: "user-1",
        }),
      }),
    );
  });

  it("uses sinceIso instead of recomputing sinceDays on retry", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sinceIso = "2026-03-15T12:00:00.000Z";

    await runSyncJob(createMockJob({ sinceDays: 30, sinceIso }), mockDb);

    expect(provider.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mockDb,
        window: SyncWindow.fromIsoRange({
          sinceIso,
          untilIso: new Date(now).toISOString(),
        }),
        options: expect.objectContaining({
          onProgress: expect.any(Function),
          userId: "user-1",
        }),
      }),
    );
  });

  it("passes a Redis-backed checkpoint store to providers", async () => {
    const initialCheckpoint = { phase: "sleep", nextDate: "2026-03-02" };
    const savedCheckpoint = { phase: "daily_metrics", nextDate: "2026-03-03" };
    const observedCheckpoints: unknown[] = [];
    const provider = createMockProvider({
      id: "garmin",
      name: "Garmin",
      sync: vi.fn().mockImplementation(async (run: SyncRun): Promise<SyncResult> => {
        const options = run.options;
        observedCheckpoints.push(await options?.checkpoint?.load());
        await options?.checkpoint?.save(savedCheckpoint);
        return { provider: "garmin", recordsSynced: 1, errors: [], duration: 10 };
      }),
    });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const job = createMockJob({
      providerId: "garmin",
      checkpoint: initialCheckpoint,
      processingOperationIds: { garmin: processingOperationId },
    });

    await runSyncJob(job, mockDb);

    expect(observedCheckpoints).toEqual([initialCheckpoint]);
    expect(job.updateData).toHaveBeenCalledWith({
      providerId: "garmin",
      processingOperationIds: { garmin: processingOperationId },
      userId: "user-1",
      checkpoint: savedCheckpoint,
    });
    expect(job.data.checkpoint).toEqual(savedCheckpoint);
  });

  it("uses epoch when sinceDays is not provided", async () => {
    const provider = createMockProvider({ id: "test", name: "Test" });
    mockGetEnabledSyncProviders.mockReturnValue([provider]);

    const now = new Date("2026-06-18T15:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());

    await runSyncJob(createMockJob({}), mockDb);

    expect(provider.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mockDb,
        window: SyncWindow.full(now),
        options: expect.objectContaining({
          onProgress: expect.any(Function),
          userId: "user-1",
        }),
      }),
    );
  });
});
