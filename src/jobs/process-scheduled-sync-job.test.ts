import { beforeEach, describe, expect, it, vi } from "vitest";

/** Per-provider mock queues keyed by provider ID */
const providerQueues = new Map<
  string,
  {
    add: ReturnType<typeof vi.fn>;
    getJobs: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
    getActive: ReturnType<typeof vi.fn>;
    getWaiting: ReturnType<typeof vi.fn>;
    getDelayed: ReturnType<typeof vi.fn>;
  }
>();
const mockLoggerInfo = vi.fn();
const mockGetActiveCooldown = vi.fn();

function getMockQueue(providerId: string) {
  const existing = providerQueues.get(providerId);
  if (existing) return existing;

  const queue = {
    add: vi.fn((..._args: unknown[]) => Promise.resolve({ id: "job-1" })),
    getJobs: vi.fn(async () => []),
    getJob: vi.fn(async () => undefined),
    getActive: vi.fn(async () => []),
    getWaiting: vi.fn(async () => []),
    getDelayed: vi.fn(async () => []),
  };
  providerQueues.set(providerId, queue);
  return queue;
}

vi.mock("./queues.ts", () => ({
  getProviderSyncQueue: vi.fn((providerId: string) => getMockQueue(providerId)),
  SYNC_JOB_RETRY_OPTIONS: {
    attempts: 288,
    backoff: { type: "fixed", delay: 300_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 1_000 },
  },
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));

vi.mock("../providers/index.ts", () => ({
  getProvider: (providerId: string) => {
    if (providerId === "strong-csv") return { id: providerId, importOnly: true as const };
    if (providerId === "whoop") return { id: providerId, scheduledSyncLookbackDays: 30 };
    if (providerId === "unknown-provider") return undefined;
    return { id: providerId };
  },
  isSyncEligibleProvider: (provider: { importOnly?: boolean }) => !provider.importOnly,
}));

vi.mock("./provider-registration.ts", () => ({
  ensureProvidersRegistered: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./provider-rate-limit-cooldown.ts", () => ({
  providerRateLimitCooldownStore: {
    getActive: (...args: unknown[]) => mockGetActiveCooldown(...args),
  },
  providerRateLimitDelayMs: vi.fn(() => 600_000),
  providerRateLimitCooldownJobId: vi.fn(() => "rate-limit-delayed-job"),
}));

const { processScheduledSyncJob } = await import("./process-scheduled-sync-job.ts");

function createScheduledSyncJob() {
  return {
    data: { type: "scheduled-sync-all" as const },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

describe("processScheduledSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerQueues.clear();
    mockGetActiveCooldown.mockReset();
    mockGetActiveCooldown.mockResolvedValue(null);
  });

  it("enqueues sync jobs into per-provider queues for non-CSV providers only", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { user_id: "user-1", provider_id: "strava" },
        { user_id: "user-1", provider_id: "strong-csv" },
        { user_id: "user-2", provider_id: "wahoo" },
        { user_id: "user-3", provider_id: "whoop" },
      ]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [createScheduledSyncJob(), db]);

    // Each provider gets its own queue
    const stravaQueue = getMockQueue("strava");
    const wahooQueue = getMockQueue("wahoo");
    const whoopQueue = getMockQueue("whoop");

    expect(stravaQueue.add).toHaveBeenCalledTimes(1);
    expect(stravaQueue.add).toHaveBeenCalledWith(
      "sync",
      {
        userId: "user-1",
        providerId: "strava",
        sinceDays: 1,
      },
      expect.objectContaining({ attempts: 288 }),
    );

    expect(wahooQueue.add).toHaveBeenCalledTimes(1);
    expect(wahooQueue.add).toHaveBeenCalledWith(
      "sync",
      {
        userId: "user-2",
        providerId: "wahoo",
        sinceDays: 1,
      },
      expect.objectContaining({ attempts: 288 }),
    );

    expect(whoopQueue.add).toHaveBeenCalledTimes(1);
    expect(whoopQueue.add).toHaveBeenCalledWith(
      "sync",
      {
        userId: "user-3",
        providerId: "whoop",
        sinceDays: 30,
      },
      expect.objectContaining({ attempts: 288 }),
    );

    // CSV provider queue should not be created
    expect(providerQueues.has("strong-csv")).toBe(false);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping CSV provider strong-csv",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Enqueued 3 sync jobs for 3 users",
    );
  });

  it("reuses the same queue instance for multiple users of the same provider", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { user_id: "user-1", provider_id: "strava" },
        { user_id: "user-2", provider_id: "strava" },
      ]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [createScheduledSyncJob(), db]);

    const stravaQueue = getMockQueue("strava");
    expect(stravaQueue.add).toHaveBeenCalledTimes(2);
    // Only one queue instance created for strava
    expect(providerQueues.size).toBe(1);
  });

  it("defaults sinceDays when provider metadata is missing", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ user_id: "user-1", provider_id: "unknown-provider" }]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [createScheduledSyncJob(), db]);

    const unknownQueue = getMockQueue("unknown-provider");
    expect(unknownQueue.add).toHaveBeenCalledWith(
      "sync",
      {
        userId: "user-1",
        providerId: "unknown-provider",
        sinceDays: 1,
      },
      expect.objectContaining({ attempts: 288 }),
    );
  });

  it("skips enqueue when a provider cooldown is active", async () => {
    const cooldown = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };
    mockGetActiveCooldown.mockResolvedValue(cooldown);
    const db = {
      execute: vi.fn().mockResolvedValue([{ user_id: "user-1", provider_id: "garmin" }]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [createScheduledSyncJob(), db]);

    const garminQueue = getMockQueue("garmin");
    expect(garminQueue.add).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping garmin for user-1: rate-limit cooldown active",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Enqueued 0 sync jobs for 1 users (1 skipped due to rate-limit cooldown)",
    );
  });

  it("skips enqueue when a step-chain provider already has pending sync jobs", async () => {
    const garminQueue = getMockQueue("garmin");
    garminQueue.getActive = vi.fn().mockResolvedValue([
      {
        data: {
          userId: "user-1",
          providerId: "garmin",
          checkpoint: { phase: "api", stepIndex: 2 },
        },
      },
    ]);

    const db = {
      execute: vi.fn().mockResolvedValue([{ user_id: "user-1", provider_id: "garmin" }]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [createScheduledSyncJob(), db]);

    expect(garminQueue.add).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping garmin for user-1: 1 sync job(s) already queued",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Enqueued 0 sync jobs for 1 users (1 skipped due to in-flight sync)",
    );
  });

  it("reports progress while faning out scheduled sync jobs", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { user_id: "user-1", provider_id: "strava" },
        { user_id: "user-2", provider_id: "wahoo" },
      ]),
    };
    const job = createScheduledSyncJob();

    await Reflect.apply(processScheduledSyncJob, undefined, [job, db]);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting scheduled sync fanout...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 10,
      message: "Loading connected providers...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 25,
      message: "Found 2 provider connections for 2 users.",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 60,
      message: "Scheduled 1 sync jobs, skipped 0.",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 95,
      message: "Scheduled 2 sync jobs, skipped 0.",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Scheduled 2 sync jobs for 2 users.",
    });
  });
});
