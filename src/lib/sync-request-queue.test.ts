import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncJobData } from "../jobs/queues.ts";

const mockGetActive = vi.fn();
const mockGetWaiting = vi.fn();
const mockGetDelayed = vi.fn();
vi.mock("../jobs/queues.ts", () => ({
  getProviderSyncQueue: vi.fn(() => ({
    getActive: mockGetActive,
    getWaiting: mockGetWaiting,
    getDelayed: mockGetDelayed,
  })),
}));

const mockSyncApiQueryKey = vi.fn();
vi.mock("./sync-api-query.ts", () => ({
  syncApiQueryKey: mockSyncApiQueryKey,
}));

const mockResolveSyncRequestQuery = vi.fn();
vi.mock("./sync-request-query.ts", () => ({
  resolveSyncRequestQuery: mockResolveSyncRequestQuery,
  registerSyncRequestQueryResolver: vi.fn(),
}));

const { listProviderSyncJobsForUser, listPendingSyncRequestQueryKeys } = await import(
  "./sync-request-queue.ts"
);

function job(data: Partial<SyncJobData>) {
  return { data: { userId: "user-1", ...data } };
}

describe("listProviderSyncJobsForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActive.mockResolvedValue([]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([]);
  });

  it("fetches from active, waiting, and delayed queues", async () => {
    await listProviderSyncJobsForUser("garmin", "user-1");

    expect(mockGetActive).toHaveBeenCalledOnce();
    expect(mockGetWaiting).toHaveBeenCalledOnce();
    expect(mockGetDelayed).toHaveBeenCalledWith();
  });

  it("filters jobs by userId across all job states", async () => {
    mockGetActive.mockResolvedValue([job({ userId: "user-1" })]);
    mockGetWaiting.mockResolvedValue([job({ userId: "user-2" })]);
    mockGetDelayed.mockResolvedValue([job({ userId: "user-1" })]);

    const result = await listProviderSyncJobsForUser("garmin", "user-1");

    expect(result).toHaveLength(2);
    expect(result.every((j) => j.data.userId === "user-1")).toBe(true);
  });

  it("returns empty array when no jobs match userId", async () => {
    const result = await listProviderSyncJobsForUser("garmin", "user-1");

    expect(result).toHaveLength(0);
  });

  it("returns empty array when queue has no jobs", async () => {
    const result = await listProviderSyncJobsForUser("garmin", "user-1");

    expect(result).toHaveLength(0);
  });
});

describe("listPendingSyncRequestQueryKeys", () => {
  beforeEach(() => {
    mockGetActive.mockResolvedValue([]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([]);
  });

  it("collects query keys for jobs with queries", async () => {
    mockGetActive.mockResolvedValue([
      job({ userId: "user-1", sinceIso: "2026-01-01T00:00:00Z" }),
      job({ userId: "user-1", sinceIso: "2026-02-01T00:00:00Z" }),
    ]);

    mockResolveSyncRequestQuery.mockImplementation((_providerId, jobData) => ({
      path: "sync",
      filters: { sinceIso: jobData.sinceIso },
    }));
    mockSyncApiQueryKey.mockImplementation(
      (query) => `${query.path}?since=${query.filters.sinceIso}`,
    );

    const result = await listPendingSyncRequestQueryKeys("garmin", "user-1");

    expect(result).toEqual(
      new Set(["sync?since=2026-01-01T00:00:00Z", "sync?since=2026-02-01T00:00:00Z"]),
    );
  });

  it("deduplicates identical query keys", async () => {
    mockGetActive.mockResolvedValue([
      job({ userId: "user-1", sinceIso: "2026-01-01T00:00:00Z" }),
      job({ userId: "user-1", sinceIso: "2026-01-01T00:00:00Z" }),
    ]);

    mockResolveSyncRequestQuery.mockImplementation((_providerId, jobData) => ({
      path: "sync",
      filters: { sinceIso: jobData.sinceIso },
    }));
    mockSyncApiQueryKey.mockImplementation(
      (query) => `${query.path}?since=${query.filters.sinceIso}`,
    );

    const result = await listPendingSyncRequestQueryKeys("garmin", "user-1");

    expect(result).toEqual(new Set(["sync?since=2026-01-01T00:00:00Z"]));
  });

  it("skips jobs where resolveSyncRequestQuery returns null", async () => {
    mockGetActive.mockResolvedValue([job({ userId: "user-1", sinceIso: "2026-01-01T00:00:00Z" })]);

    mockResolveSyncRequestQuery.mockReturnValue(null);

    const result = await listPendingSyncRequestQueryKeys("garmin", "user-1");

    expect(result).toEqual(new Set());
  });

  it("returns empty set when queue has no jobs", async () => {
    mockGetActive.mockResolvedValue([]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([]);

    const result = await listPendingSyncRequestQueryKeys("garmin", "user-1");

    expect(result).toEqual(new Set());
  });
});
