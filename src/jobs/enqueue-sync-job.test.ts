import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetActive = vi.fn();
const mockProviderQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });
const mockGetJob = vi.fn().mockResolvedValue(undefined);

vi.mock("./provider-rate-limit-cooldown.ts", () => ({
  providerRateLimitCooldownStore: {
    getActive: (...args: unknown[]) => mockGetActive(...args),
  },
  providerRateLimitDelayMs: vi.fn(() => 600_000),
  providerRateLimitCooldownJobId: vi.fn(() => "rate-limit-delayed-job"),
}));

vi.mock("./queues.ts", () => ({
  getProviderSyncQueue: vi.fn(() => ({ add: mockProviderQueueAdd, getJob: mockGetJob })),
  SYNC_JOB_RETRY_OPTIONS: {
    attempts: 288,
    backoff: { type: "fixed", delay: 300_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 1_000 },
  },
}));

const { enqueueSyncJob, scheduleDelayedSyncJob, syncJobOptionsWithRateLimitCooldown } =
  await import("./enqueue-sync-job.ts");

describe("enqueueSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActive.mockResolvedValue(null);
    mockGetJob.mockResolvedValue(undefined);
    mockProviderQueueAdd.mockResolvedValue({ id: "job-1" });
  });

  it("enqueues immediately when no cooldown is active", async () => {
    await enqueueSyncJob("garmin", { userId: "user-1", providerId: "garmin", sinceDays: 1 });

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      { userId: "user-1", providerId: "garmin", sinceDays: 1 },
      expect.objectContaining({ attempts: 288 }),
    );
  });

  it("adds lifecycle-scoped deduplication to a user-triggered initial full sync", async () => {
    await enqueueSyncJob(
      "garmin",
      {
        userId: "user-1",
        providerId: "garmin",
        sinceIso: "1970-01-01T00:00:00.000Z",
        untilIso: "2026-07-29T17:00:00.000Z",
        targetRefreshWindow: { type: "full" },
      },
      { singleFlightFullSync: true },
    );

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({ targetRefreshWindow: { type: "full" } }),
      expect.objectContaining({
        deduplication: { id: "sync:full:garmin:user-1" },
      }),
    );
  });

  it("does not reuse the initial full-sync deduplication key for a checkpoint continuation", async () => {
    await enqueueSyncJob(
      "garmin",
      {
        userId: "user-1",
        providerId: "garmin",
        sinceIso: "1970-01-01T00:00:00.000Z",
        untilIso: "2026-07-29T17:00:00.000Z",
        targetRefreshWindow: { type: "full" },
        checkpoint: { phase: "api", stepIndex: 2 },
      },
      { singleFlightFullSync: true },
    );

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({ checkpoint: { phase: "api", stepIndex: 2 } }),
      expect.not.objectContaining({ deduplication: expect.anything() }),
    );
  });

  it("does not lifecycle-deduplicate non-user-triggered full sync work", async () => {
    await enqueueSyncJob("garmin", {
      userId: "user-1",
      providerId: "garmin",
      sinceIso: "1970-01-01T00:00:00.000Z",
      untilIso: "2026-07-29T17:00:00.000Z",
      targetRefreshWindow: { type: "full" },
    });

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      expect.objectContaining({ targetRefreshWindow: { type: "full" } }),
      expect.not.objectContaining({ deduplication: expect.anything() }),
    );
  });

  it("enqueues with delay when a cooldown is active", async () => {
    mockGetActive.mockResolvedValue({
      providerId: "garmin",
      scope: "provider",
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    });

    await enqueueSyncJob("garmin", { userId: "user-1", providerId: "garmin", sinceDays: 1 });

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      { userId: "user-1", providerId: "garmin", sinceDays: 1 },
      expect.objectContaining({
        attempts: 288,
        delay: 600_000,
        jobId: "rate-limit-delayed-job",
      }),
    );
  });

  it("schedules a delayed retry for an existing cooldown", async () => {
    const cooldown = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };
    mockGetActive.mockResolvedValue(cooldown);

    const retryAt = await scheduleDelayedSyncJob(
      {
        userId: "user-1",
        providerId: "garmin",
        sinceIso: "2026-06-01T00:00:00.000Z",
        untilIso: "2026-06-02T23:59:59.999Z",
      },
      cooldown,
    );

    expect(retryAt).toBe("2026-06-02T12:10:00.000Z");
    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      {
        userId: "user-1",
        providerId: "garmin",
        sinceIso: "2026-06-01T00:00:00.000Z",
        untilIso: "2026-06-02T23:59:59.999Z",
      },
      expect.objectContaining({
        delay: 600_000,
        jobId: "rate-limit-delayed-job",
      }),
    );
  });

  it("returns the existing delayed cooldown job instead of enqueueing a duplicate", async () => {
    const cooldown = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };
    mockGetActive.mockResolvedValue(cooldown);
    const existingJob = {
      id: "rate-limit-delayed-job",
      getState: vi.fn().mockResolvedValue("delayed"),
    };
    mockGetJob.mockResolvedValue(existingJob);

    await scheduleDelayedSyncJob(
      {
        userId: "user-1",
        providerId: "garmin",
        sinceIso: "2026-06-01T00:00:00.000Z",
        untilIso: "2026-06-02T23:59:59.999Z",
        checkpoint: { phase: "api", stepIndex: 2 },
      },
      cooldown,
    );

    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
    expect(mockGetJob).toHaveBeenCalledWith("rate-limit-delayed-job");
  });

  it("returns default retry options when no cooldown is active", async () => {
    await expect(syncJobOptionsWithRateLimitCooldown("garmin", "user-1")).resolves.toEqual(
      expect.objectContaining({ attempts: 288 }),
    );
  });

  it("checks cooldown for the requested provider and user", async () => {
    await enqueueSyncJob("garmin", { userId: "user-1", providerId: "garmin", sinceDays: 1 });
    expect(mockGetActive).toHaveBeenCalledWith("garmin", "user-1");
  });

  it("skips enqueue when skipWhenRateLimited is set and a cooldown is active", async () => {
    mockGetActive.mockResolvedValue({
      providerId: "garmin",
      scope: "provider",
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    });

    const result = await enqueueSyncJob(
      "garmin",
      { userId: "user-1", providerId: "garmin", sinceDays: 1 },
      { skipWhenRateLimited: true },
    );

    expect(result).toBeNull();
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
  });

  it("deduplicates step-chain jobs by provider request path and filters", async () => {
    const existingJob = {
      id: "existing-hr",
      getState: vi.fn().mockResolvedValue("waiting"),
    };
    mockGetJob.mockResolvedValue(existingJob);

    const result = await enqueueSyncJob("whoop", {
      userId: "user-1",
      providerId: "whoop",
      sinceIso: "2026-05-01T00:00:00.000Z",
      untilIso: "2026-05-03T00:00:00.000Z",
      checkpoint: {
        runId: "run-1",
        recordsSynced: 0,
        phase: "api",
        cycleFetchCursorMs: null,
        cycles: [],
        apiSteps: [
          {
            type: "heart_rate",
            start: "2026-05-01T00:00:00.000Z",
            end: "2026-05-08T00:00:00.000Z",
          },
        ],
        apiStepIndex: 0,
        presentExternalIds: [],
      },
    });

    expect(result).toBe(existingJob);
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
    expect(mockGetJob).toHaveBeenCalledWith(expect.stringMatching(/^sync-req-whoop-user-1-/));
  });

  it("deduplicates standard provider jobs by sync window", async () => {
    const existingJob = {
      id: "existing-strava",
      getState: vi.fn().mockResolvedValue("waiting"),
    };
    mockGetJob.mockResolvedValue(existingJob);

    const result = await enqueueSyncJob("strava", {
      userId: "user-1",
      providerId: "strava",
      sinceIso: "2026-05-01T00:00:00.000Z",
      untilIso: "2026-05-03T00:00:00.000Z",
    });

    expect(result).toBe(existingJob);
    expect(mockProviderQueueAdd).not.toHaveBeenCalled();
    expect(mockGetJob).toHaveBeenCalledWith(expect.stringMatching(/^sync-req-strava-user-1-/));
  });
});
