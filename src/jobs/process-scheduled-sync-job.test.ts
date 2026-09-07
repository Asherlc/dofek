import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, SyncDatabase } from "../db/index.ts";

/** Per-provider mock queues keyed by provider ID */
const providerQueues = new Map<
  string,
  {
    add: CallableVitestMock;
    getJobs: CallableVitestMock;
    getJob: CallableVitestMock;
    getActive: CallableVitestMock;
    getWaiting: CallableVitestMock;
    getDelayed: CallableVitestMock;
  }
>();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockGetActiveCooldown = vi.fn();
const mockCaptureException = vi.fn();
const mockWithUserWriteFence = vi.fn();
class MockAccountErasureUserFencedError extends Error {}

vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("../db/account-erasure.ts", () => ({
  AccountErasureUserFencedError: MockAccountErasureUserFencedError,
  withAccountErasureUserWriteFence: mockWithUserWriteFence,
}));

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
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

vi.mock("../providers/index.ts", () => ({
  getProvider: (providerId: string) => {
    if (providerId === "strong-csv") return { id: providerId, importOnly: true as const };
    if (providerId === "whoop") return { id: providerId, scheduledSyncLookbackDays: 30 };
    if (providerId === "unknown-provider") return undefined;
    if (["strava", "wahoo", "garmin"].includes(providerId)) {
      return { id: providerId, authSetup: () => ({}) };
    }
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

interface ScheduledSyncRow {
  user_id: string;
  provider_id: string;
  has_tokens: boolean;
}

type ScheduledSyncDatabase = SyncDatabase & Pick<Database, "transaction">;

function createScheduledSyncDatabase(rows: ScheduledSyncRow[]): ScheduledSyncDatabase {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue(rows),
    transaction: vi.fn(),
  };
}

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
    mockCaptureException.mockClear();
    mockWithUserWriteFence.mockReset();
    mockWithUserWriteFence.mockImplementation(
      async (
        database: ScheduledSyncDatabase,
        _userId: string,
        operation: (database: ScheduledSyncDatabase) => Promise<unknown>,
      ) => operation(database),
    );
  });

  it("enqueues sync jobs into per-provider queues for non-CSV providers only", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
      { user_id: "user-1", provider_id: "strong-csv", has_tokens: false },
      { user_id: "user-2", provider_id: "wahoo", has_tokens: true },
      { user_id: "user-3", provider_id: "whoop", has_tokens: true },
    ]);

    const job = createScheduledSyncJob();

    await processScheduledSyncJob(job, db);

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
        origin: "scheduled",
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
        origin: "scheduled",
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
        origin: "scheduled",
      },
      expect.objectContaining({ attempts: 288 }),
    );

    // CSV provider queue should not be created
    expect(providerQueues.has("strong-csv")).toBe(false);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping non-sync provider strong-csv",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Enqueued 3 sync jobs for 3 users",
    );
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 60,
      message: "Scheduled 1 sync jobs, skipped 0.",
    });
  });

  it("reuses the same queue instance for multiple users of the same provider", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
      { user_id: "user-2", provider_id: "strava", has_tokens: true },
    ]);

    await processScheduledSyncJob(createScheduledSyncJob(), db);

    const stravaQueue = getMockQueue("strava");
    expect(stravaQueue.add).toHaveBeenCalledTimes(2);
    // Only one queue instance created for strava
    expect(providerQueues.size).toBe(1);
  });

  it("holds each user's account-erasure fence while enqueueing scheduled syncs", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
      { user_id: "user-2", provider_id: "wahoo", has_tokens: true },
    ]);

    await processScheduledSyncJob(createScheduledSyncJob(), db);

    expect(mockWithUserWriteFence).toHaveBeenCalledTimes(2);
    expect(mockWithUserWriteFence).toHaveBeenNthCalledWith(1, db, "user-1", expect.any(Function));
    expect(mockWithUserWriteFence).toHaveBeenNthCalledWith(2, db, "user-2", expect.any(Function));
  });

  it("skips a fenced account without starving later users", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
      { user_id: "user-2", provider_id: "wahoo", has_tokens: true },
    ]);
    mockWithUserWriteFence
      .mockRejectedValueOnce(new MockAccountErasureUserFencedError())
      .mockImplementationOnce(
        async (
          database: ScheduledSyncDatabase,
          _userId: string,
          operation: (database: ScheduledSyncDatabase) => Promise<unknown>,
        ) => operation(database),
      );

    const job = createScheduledSyncJob();

    await expect(processScheduledSyncJob(job, db)).resolves.toBeUndefined();

    expect(getMockQueue("strava").add).not.toHaveBeenCalled();
    expect(getMockQueue("wahoo").add).toHaveBeenCalledOnce();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping one account with active erasure",
    );
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 60,
      message: "Scheduled 0 sync jobs, skipped 1.",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Scheduled 1 sync jobs, skipped 1, for 2 users.",
    });
  });

  it("rethrows unexpected account-erasure fence failures", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
    ]);
    const fenceError = new Error("database unavailable");
    mockWithUserWriteFence.mockRejectedValueOnce(fenceError);

    await expect(processScheduledSyncJob(createScheduledSyncJob(), db)).rejects.toBe(fenceError);
  });

  it("skips connections whose provider plugin is missing", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "unknown-provider", has_tokens: false },
    ]);

    await processScheduledSyncJob(createScheduledSyncJob(), db);

    expect(providerQueues.has("unknown-provider")).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping non-sync provider unknown-provider",
    );
  });

  it("skips a token-backed connection whose tokens are missing", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: false },
    ]);

    const job = createScheduledSyncJob();

    await processScheduledSyncJob(job, db);

    expect(getMockQueue("strava").add).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping disconnected provider strava for user-1",
    );
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 95,
      message: "Scheduled 0 sync jobs, skipped 1.",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Scheduled 0 sync jobs, skipped 1, for 1 users.",
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Enqueued 0 sync jobs for 1 users (1 skipped because disconnected)",
    );
  });

  it("rejects malformed connected-provider rows before dispatch", async () => {
    const db: ScheduledSyncDatabase = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi
        .fn()
        .mockResolvedValue([{ user_id: "user-1", provider_id: "strava", has_tokens: "true" }]),
      transaction: vi.fn(),
    };

    await expect(processScheduledSyncJob(createScheduledSyncJob(), db)).rejects.toThrow();
    expect(providerQueues.has("strava")).toBe(false);
  });

  it("skips enqueue when a provider cooldown is active", async () => {
    const cooldown = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };
    mockGetActiveCooldown.mockResolvedValue(cooldown);
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "garmin", has_tokens: true },
    ]);

    const job = createScheduledSyncJob();

    await processScheduledSyncJob(job, db);

    const garminQueue = getMockQueue("garmin");
    expect(garminQueue.add).not.toHaveBeenCalled();
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 95,
      message: "Scheduled 0 sync jobs, skipped 1.",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Scheduled 0 sync jobs, skipped 1, for 1 users.",
    });
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

    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "garmin", has_tokens: true },
    ]);

    const job = createScheduledSyncJob();

    await processScheduledSyncJob(job, db);

    expect(garminQueue.add).not.toHaveBeenCalled();
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 95,
      message: "Scheduled 0 sync jobs, skipped 1.",
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping garmin for user-1: 1 sync job(s) already queued",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Enqueued 0 sync jobs for 1 users (1 skipped due to in-flight sync)",
    );
  });

  it("does not inspect in-flight jobs for providers without step chains", async () => {
    const stravaQueue = getMockQueue("strava");
    stravaQueue.getActive = vi.fn().mockResolvedValue([
      {
        data: {
          userId: "user-1",
          providerId: "strava",
        },
      },
    ]);
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
    ]);

    await processScheduledSyncJob(createScheduledSyncJob(), db);

    expect(stravaQueue.getActive).not.toHaveBeenCalled();
    expect(stravaQueue.add).toHaveBeenCalledOnce();
  });

  it("reports combined skipped provider counts during scheduled sync dispatch", async () => {
    const cooldown = {
      providerId: "strava",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };
    mockGetActiveCooldown.mockImplementation((providerId: string) =>
      providerId === "strava" ? Promise.resolve(cooldown) : Promise.resolve(null),
    );
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
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "garmin", has_tokens: true },
      { user_id: "user-2", provider_id: "strava", has_tokens: true },
    ]);
    const job = createScheduledSyncJob();

    await processScheduledSyncJob(job, db);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 95,
      message: "Scheduled 0 sync jobs, skipped 2.",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Scheduled 0 sync jobs, skipped 2, for 2 users.",
    });
  });

  it("reports progress while dispatching scheduled sync jobs", async () => {
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
      { user_id: "user-2", provider_id: "wahoo", has_tokens: true },
    ]);
    const job = createScheduledSyncJob();

    await processScheduledSyncJob(job, db);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting scheduled sync dispatch...",
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
      message: "Scheduled 2 sync jobs, skipped 0, for 2 users.",
    });
  });

  it("continues scheduled sync dispatch when progress updates fail", async () => {
    const progressError = new Error("redis down");
    const db = createScheduledSyncDatabase([
      { user_id: "user-1", provider_id: "strava", has_tokens: true },
    ]);
    const job = createScheduledSyncJob();
    job.updateProgress = vi.fn().mockRejectedValue(progressError);

    await processScheduledSyncJob(job, db);

    expect(getMockQueue("strava").add).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(progressError, {
      tags: { scheduledSyncStep: "updateProgress" },
    });
  });
});
