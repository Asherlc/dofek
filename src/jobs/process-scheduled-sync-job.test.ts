import { beforeEach, describe, expect, it, vi } from "vitest";

/** Per-provider mock queues keyed by provider ID */
const providerQueues = new Map<
  string,
  { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
>();
const mockLoggerInfo = vi.fn();

function getMockQueue(providerId: string) {
  const existing = providerQueues.get(providerId);
  if (existing) return existing;

  const queue = {
    add: vi.fn((..._args: unknown[]) => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  providerQueues.set(providerId, queue);
  return queue;
}

vi.mock("./queues.ts", () => ({
  createProviderSyncQueue: vi.fn((providerId: string) => getMockQueue(providerId)),
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));

vi.mock("../providers/index.ts", () => ({
  getProvider: (providerId: string) => {
    if (providerId === "strong-csv") return { id: providerId, importOnly: true as const };
    return { id: providerId };
  },
  isSyncEligibleProvider: (provider: { importOnly?: boolean }) => !provider.importOnly,
}));

vi.mock("./provider-registration.ts", () => ({
  ensureProvidersRegistered: vi.fn().mockResolvedValue(undefined),
}));

const { processScheduledSyncJob } = await import("./process-scheduled-sync-job.ts");

describe("processScheduledSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerQueues.clear();
  });

  it("enqueues sync jobs into per-provider queues for non-CSV providers only", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { user_id: "user-1", provider_id: "strava" },
        { user_id: "user-1", provider_id: "strong-csv" },
        { user_id: "user-2", provider_id: "wahoo" },
      ]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [{}, db]);

    // Each provider gets its own queue
    const stravaQueue = getMockQueue("strava");
    const wahooQueue = getMockQueue("wahoo");

    expect(stravaQueue.add).toHaveBeenCalledTimes(1);
    expect(stravaQueue.add).toHaveBeenCalledWith("sync", {
      userId: "user-1",
      providerId: "strava",
      sinceDays: 1,
    });

    expect(wahooQueue.add).toHaveBeenCalledTimes(1);
    expect(wahooQueue.add).toHaveBeenCalledWith("sync", {
      userId: "user-2",
      providerId: "wahoo",
      sinceDays: 1,
    });

    // CSV provider queue should not be created
    expect(providerQueues.has("strong-csv")).toBe(false);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping CSV provider strong-csv",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Enqueued 2 sync jobs for 2 users",
    );

    // All opened queues should be closed
    expect(stravaQueue.close).toHaveBeenCalled();
    expect(wahooQueue.close).toHaveBeenCalled();
  });

  it("reuses the same queue instance for multiple users of the same provider", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { user_id: "user-1", provider_id: "strava" },
        { user_id: "user-2", provider_id: "strava" },
      ]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [{}, db]);

    const stravaQueue = getMockQueue("strava");
    expect(stravaQueue.add).toHaveBeenCalledTimes(2);
    // Only one queue instance created for strava
    expect(providerQueues.size).toBe(1);
  });
});
