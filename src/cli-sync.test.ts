import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturedWorkerCallbacks,
  MockQueueEvents,
  MockWorker,
  mockAdd,
  mockCaptureException,
  mockCloseAccountErasureWorkLockPool,
  mockDbExecute,
  mockEnsureProvidersRegistered,
  mockGetEnabledSyncProviders,
  mockLoggerError,
  mockLoggerInfo,
  mockProcessFitFileImportJob,
  mockProcessSyncJob,
  mockQueueClose,
  mockQueueEventsClose,
  mockRedisConnection,
  mockSyncJobRetryOptions,
  mockWaitUntilFinished,
  mockWorkerClose,
} from "./cli-test/test-helpers.ts";

const { handleSyncCommand } = await import("./cli-sync.ts");
beforeEach(() => {
  mockDbExecute.mockReset();
  mockDbExecute.mockResolvedValue([{ id: "test-user" }]);
});

describe("handleSyncCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWorkerCallbacks.clear();
    mockAdd.mockResolvedValue({ waitUntilFinished: mockWaitUntilFinished });
    mockWaitUntilFinished.mockResolvedValue(undefined);
  });

  it("reports terminal CLI sync failure to Sentry", async () => {
    const error = new Error("OpenBeta retries exhausted");
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "openbeta" }]);
    mockWaitUntilFinished.mockRejectedValue(error);
    expect(await handleSyncCommand(["node", "index.ts", "sync"])).toBe(1);
    expect(mockCaptureException).toHaveBeenCalledWith(error, { tags: { phase: "cli-sync" } });
  });

  it("waits for terminal job failure before reporting transient attempts", async () => {
    const transientError = new Error("OpenBeta unavailable");
    const terminalError = new Error("OpenBeta retries exhausted");
    let rejectTerminal!: (error: Error) => void;
    const completion = new Promise<void>((_resolve, reject) => {
      rejectTerminal = reject;
    });
    mockWaitUntilFinished.mockReturnValue(completion);
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "openbeta" }]);
    mockProcessSyncJob.mockRejectedValueOnce(transientError);
    const command = handleSyncCommand(["node", "index.ts", "sync"]);
    await vi.waitFor(() => expect(capturedWorkerCallbacks.has("sync")).toBe(true));
    await expect(
      capturedWorkerCallbacks.get("sync")?.({ data: { userId: "test-user" } }),
    ).rejects.toBe(transientError);
    expect(mockCaptureException).not.toHaveBeenCalled();
    rejectTerminal(terminalError);
    expect(await command).toBe(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(terminalError, {
      tags: { phase: "cli-sync" },
    });
  });

  it("returns 0 when no providers are enabled", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([]);
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("logs message when no providers enabled", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[sync] No syncable providers enabled. Set API keys in .env to enable providers.",
    );
  });

  it("registers providers before checking enabled list", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockEnsureProvidersRegistered).toHaveBeenCalledOnce();
  });

  it("enqueues sync job with providerId and default sinceDays", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(0);
    expect(mockAdd).toHaveBeenCalledWith(
      "sync",
      {
        providerId: "strava",
        sinceDays: 7,
        userId: "test-user",
        origin: "manual",
      },
      mockSyncJobRetryOptions,
    );
  });

  it("enqueues one sync job per enabled provider", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }, { id: "wahoo" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(mockAdd).toHaveBeenCalledTimes(2);
    expect(mockAdd).toHaveBeenNthCalledWith(
      1,
      "sync",
      {
        providerId: "strava",
        sinceDays: 7,
        userId: "test-user",
        origin: "manual",
      },
      mockSyncJobRetryOptions,
    );
    expect(mockAdd).toHaveBeenNthCalledWith(
      2,
      "sync",
      {
        providerId: "wahoo",
        sinceDays: 7,
        userId: "test-user",
        origin: "manual",
      },
      mockSyncJobRetryOptions,
    );
  });

  it("logs enqueue message with provider count and day range", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }, { id: "wahoo" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[sync] Enqueued 2 sync job(s), one per provider"),
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("last 7 days"));
  });

  it("logs 'all time' label for full sync", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync", "--full-sync"]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("all time"));
  });

  it("creates Worker with processSyncJob callback and connection", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(MockWorker).toHaveBeenCalledWith("sync", expect.any(Function), {
      connection: mockRedisConnection,
    });
    // Verify the callback calls processSyncJob by invoking the captured callback
    const capturedWorkerCallback = capturedWorkerCallbacks.get("sync");
    expect(capturedWorkerCallback).toBeDefined();
    expect(capturedWorkerCallback).toHaveLength(3);
    const fakeJob = { data: { userId: "test-user" }, id: "123" };
    const signal = new AbortController().signal;
    await capturedWorkerCallback?.(fakeJob, undefined, signal);
    expect(mockProcessSyncJob).toHaveBeenCalledWith(fakeJob, expect.any(Object), signal);
  });

  it("runs a temporary FIT import worker for provider sync child jobs", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "wahoo" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(MockWorker).toHaveBeenCalledWith("fit-file-import", expect.any(Function), {
      connection: mockRedisConnection,
    });
    const capturedFitWorkerCallback = capturedWorkerCallbacks.get("fit-file-import");
    expect(capturedFitWorkerCallback).toBeDefined();
    const fakeJob = { data: { userId: "test-user" }, id: "fit-123" };
    await capturedFitWorkerCallback?.(fakeJob);
    expect(mockProcessFitFileImportJob).toHaveBeenCalledWith(fakeJob, expect.any(Object));
  });

  it("closes the queued-work lock pool after temporary workers stop", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);

    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(mockCloseAccountErasureWorkLockPool).toHaveBeenCalledOnce();
  });

  it("creates QueueEvents with connection", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);

    expect(MockQueueEvents).toHaveBeenCalledWith("sync", {
      connection: mockRedisConnection,
    });
  });

  it("logs done message on success", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockLoggerInfo).toHaveBeenCalledWith("[sync] Done.");
  });

  it("returns 1 when job fails", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    mockWaitUntilFinished.mockRejectedValue(new Error("sync failed"));
    const code = await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(code).toBe(1);
  });

  it("logs error message on failure", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    mockWaitUntilFinished.mockRejectedValue(new Error("sync failed"));
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining("[sync] Failed:"));
  });

  it("passes undefined sinceDays for --full-sync", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync", "--full-sync"]);
    expect(mockAdd).toHaveBeenCalledWith(
      "sync",
      {
        providerId: "strava",
        sinceDays: undefined,
        userId: "test-user",
        origin: "manual",
      },
      mockSyncJobRetryOptions,
    );
  });

  it("passes custom --since-days value", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync", "--since-days=30"]);
    expect(mockAdd).toHaveBeenCalledWith(
      "sync",
      {
        providerId: "strava",
        sinceDays: 30,
        userId: "test-user",
        origin: "manual",
      },
      mockSyncJobRetryOptions,
    );
  });

  it("uses DOFEK_USER_ID when provided and skips DB user lookup", async () => {
    const priorUserId = process.env.DOFEK_USER_ID;
    process.env.DOFEK_USER_ID = "env-user-123";
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    mockDbExecute.mockRejectedValue(new Error("should not query DB"));

    try {
      const code = await handleSyncCommand(["node", "index.ts", "sync"]);
      expect(code).toBe(0);
      expect(mockAdd).toHaveBeenCalledWith(
        "sync",
        {
          providerId: "strava",
          sinceDays: 7,
          userId: "env-user-123",
          origin: "manual",
        },
        mockSyncJobRetryOptions,
      );
      expect(mockDbExecute).not.toHaveBeenCalled();
    } finally {
      if (priorUserId === undefined) {
        delete process.env.DOFEK_USER_ID;
      } else {
        process.env.DOFEK_USER_ID = priorUserId;
      }
    }
  });

  it("throws a clear error when no user row can be resolved", async () => {
    delete process.env.DOFEK_USER_ID;
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    mockDbExecute.mockResolvedValue([]);

    await expect(handleSyncCommand(["node", "index.ts", "sync"])).rejects.toThrow(
      "No user found. Set DOFEK_USER_ID or create a user first.",
    );
  });

  it("cleans up BullMQ resources on success", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
    expect(mockQueueEventsClose).toHaveBeenCalledOnce();
    expect(mockQueueClose).toHaveBeenCalledOnce();
  });

  it("cleans up BullMQ resources on failure", async () => {
    mockGetEnabledSyncProviders.mockReturnValue([{ id: "strava" }]);
    mockWaitUntilFinished.mockRejectedValue(new Error("boom"));
    await handleSyncCommand(["node", "index.ts", "sync"]);
    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
    expect(mockQueueEventsClose).toHaveBeenCalledOnce();
    expect(mockQueueClose).toHaveBeenCalledOnce();
  });
});
