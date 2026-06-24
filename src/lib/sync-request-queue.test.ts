import { describe, expect, it, vi } from "vitest";
import type { SyncJobData } from "../jobs/queues.ts";

const mockGetJobs = vi.fn();
vi.mock("../jobs/queues.ts", () => ({
  getProviderSyncQueue: vi.fn(() => ({ getJobs: mockGetJobs })),
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

const PENDING_SYNC_JOB_STATES = ["active", "waiting", "delayed"];

function job(data: Partial<SyncJobData>) {
  return { data: { userId: "user-1", ...data } };
}

describe("listProviderSyncJobsForUser", () => {
  it("calls getJobs with pending states", async () => {
    mockGetJobs.mockResolvedValue([]);

    await listProviderSyncJobsForUser("garmin", "user-1");

    expect(mockGetJobs).toHaveBeenCalledWith([...PENDING_SYNC_JOB_STATES]);
  });

  it("filters jobs by userId", async () => {
    mockGetJobs.mockResolvedValue([
      job({ userId: "user-1" }),
      job({ userId: "user-2" }),
      job({ userId: "user-1" }),
    ]);

    const result = await listProviderSyncJobsForUser("garmin", "user-1");

    expect(result).toHaveLength(2);
    expect(result.every((j) => j.data.userId === "user-1")).toBe(true);
  });

  it("returns empty array when no jobs match userId", async () => {
    mockGetJobs.mockResolvedValue([job({ userId: "user-2" }), job({ userId: "user-3" })]);

    const result = await listProviderSyncJobsForUser("garmin", "user-1");

    expect(result).toHaveLength(0);
  });

  it("returns empty array when queue has no jobs", async () => {
    mockGetJobs.mockResolvedValue([]);

    const result = await listProviderSyncJobsForUser("garmin", "user-1");

    expect(result).toHaveLength(0);
  });
});

describe("listPendingSyncRequestQueryKeys", () => {
  it("collects query keys for jobs with queries", async () => {
    mockGetJobs.mockResolvedValue([
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
    mockGetJobs.mockResolvedValue([
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
    mockGetJobs.mockResolvedValue([job({ userId: "user-1", sinceIso: "2026-01-01T00:00:00Z" })]);

    mockResolveSyncRequestQuery.mockReturnValue(null);

    const result = await listPendingSyncRequestQueryKeys("garmin", "user-1");

    expect(result).toEqual(new Set());
  });

  it("returns empty set when queue has no jobs", async () => {
    mockGetJobs.mockResolvedValue([]);

    const result = await listPendingSyncRequestQueryKeys("garmin", "user-1");

    expect(result).toEqual(new Set());
  });
});
