import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWaitForPeerDbActivityDeletes = vi.fn().mockResolvedValue(undefined);
const mockWaitForPeerDbActivityRestores = vi.fn().mockResolvedValue(undefined);
const mockRunActivityReadModelBuild = vi.fn().mockResolvedValue(undefined);
const mockInvalidateByPrefix = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("../analytics/activity-read-model-build.ts", () => ({
  waitForPeerDbActivityDeletes: (...args: unknown[]) => mockWaitForPeerDbActivityDeletes(...args),
  waitForPeerDbActivityRestores: (...args: unknown[]) => mockWaitForPeerDbActivityRestores(...args),
  runActivityReadModelBuild: (...args: unknown[]) => mockRunActivityReadModelBuild(...args),
}));

vi.mock("../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: () => ({
    query: vi.fn(),
    close: mockClose,
  }),
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: (...args: unknown[]) => mockInvalidateByPrefix(...args),
  },
}));

import { processActivityDeleteAnalyticsJob } from "./process-activity-delete-analytics-job.ts";

const job = {
  data: {
    type: "activity-delete-analytics-refresh" as const,
    userId: "user-1",
    activityIds: ["00000000-0000-0000-0000-000000000001"],
  },
};

describe("processActivityDeleteAnalyticsJob", () => {
  beforeEach(() => {
    mockWaitForPeerDbActivityDeletes.mockClear();
    mockRunActivityReadModelBuild.mockClear();
    mockInvalidateByPrefix.mockClear();
    mockClose.mockClear();
    mockWaitForPeerDbActivityDeletes.mockResolvedValue(undefined);
    mockRunActivityReadModelBuild.mockResolvedValue(undefined);
  });

  it("waits for PeerDB, rebuilds activity read models, and invalidates user caches", async () => {
    await processActivityDeleteAnalyticsJob(job);

    expect(mockWaitForPeerDbActivityDeletes).toHaveBeenCalledWith(expect.anything(), [
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("closes the ClickHouse client even when refresh fails", async () => {
    mockRunActivityReadModelBuild.mockRejectedValueOnce(new Error("dbt failed"));

    await expect(processActivityDeleteAnalyticsJob(job)).rejects.toThrow("dbt failed");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("waits for restored activities before rebuilding read models", async () => {
    await processActivityDeleteAnalyticsJob({
      data: {
        type: "activity-restore-analytics-refresh",
        userId: "user-1",
        activityIds: ["00000000-0000-0000-0000-000000000002"],
      },
    });

    expect(mockWaitForPeerDbActivityRestores).toHaveBeenCalledWith(expect.anything(), [
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(mockWaitForPeerDbActivityDeletes).not.toHaveBeenCalled();
    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
  });
});
