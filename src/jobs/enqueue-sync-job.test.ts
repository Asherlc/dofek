import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetActive = vi.fn();
const mockProviderQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });

vi.mock("./provider-rate-limit-cooldown.ts", () => ({
  providerRateLimitCooldownStore: {
    getActive: (...args: unknown[]) => mockGetActive(...args),
  },
  providerRateLimitDelayMs: vi.fn(() => 600_000),
  providerRateLimitCooldownJobId: vi.fn(() => "rate-limit-delayed-job"),
}));

vi.mock("./queues.ts", () => ({
  getProviderSyncQueue: vi.fn(() => ({ add: mockProviderQueueAdd })),
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
  });

  it("enqueues immediately when no cooldown is active", async () => {
    await enqueueSyncJob("garmin", { userId: "user-1", providerId: "garmin", sinceDays: 1 });

    expect(mockProviderQueueAdd).toHaveBeenCalledWith(
      "sync",
      { userId: "user-1", providerId: "garmin", sinceDays: 1 },
      expect.objectContaining({ attempts: 288 }),
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
});
