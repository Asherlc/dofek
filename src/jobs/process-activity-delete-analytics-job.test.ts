import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWaitForPeerDbActivityDeletes = vi.fn().mockResolvedValue(undefined);
const mockRunActivityReadModelBuild = vi.fn().mockResolvedValue(undefined);
const mockInvalidateByPrefix = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("../analytics/activity-read-model-build.ts", () => ({
  waitForPeerDbActivityDeletes: (...args: unknown[]) => mockWaitForPeerDbActivityDeletes(...args),
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

describe("processActivityDeleteAnalyticsJob", () => {
  beforeEach(() => {
    mockWaitForPeerDbActivityDeletes.mockClear();
    mockRunActivityReadModelBuild.mockClear();
    mockInvalidateByPrefix.mockClear();
    mockClose.mockClear();
  });

  it("waits for PeerDB, rebuilds activity read models, and invalidates user caches", async () => {
    await processActivityDeleteAnalyticsJob({
      data: {
        type: "activity-delete-analytics-refresh",
        userId: "user-1",
        activityIds: ["00000000-0000-0000-0000-000000000001"],
      },
    });

    expect(mockWaitForPeerDbActivityDeletes).toHaveBeenCalledWith(
      expect.anything(),
      ["00000000-0000-0000-0000-000000000001"],
    );
    expect(mockRunActivityReadModelBuild).toHaveBeenCalledOnce();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
