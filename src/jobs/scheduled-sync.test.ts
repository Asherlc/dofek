import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpsertJobScheduler = vi.fn().mockResolvedValue({});

vi.mock("./queues.ts", () => ({
  createScheduledSyncQueue: vi.fn(() => ({
    upsertJobScheduler: mockUpsertJobScheduler,
    close: vi.fn().mockResolvedValue(undefined),
  })),
  SCHEDULED_SYNC_QUEUE: "scheduled-sync",
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createScheduledSyncQueue } from "./queues.ts";
import { SCHEDULER_KEY, setupScheduledSync } from "./scheduled-sync.ts";

describe("setupScheduledSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a repeatable job scheduler with the correct key and template", async () => {
    await setupScheduledSync();

    expect(createScheduledSyncQueue).toHaveBeenNthCalledWith(1, undefined, "regular");
    expect(createScheduledSyncQueue).toHaveBeenNthCalledWith(2, undefined, "daily");

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      SCHEDULER_KEY,
      expect.objectContaining({ every: expect.any(Number) }),
      {
        name: "scheduled-sync",
        data: { type: "scheduled-sync-all", cadence: "regular" },
      },
    );
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      `${SCHEDULER_KEY}-daily`,
      { every: 24 * 60 * 60 * 1000 },
      { name: "scheduled-sync", data: { type: "scheduled-sync-all", cadence: "daily" } },
    );
  });

  it("uses the exported 30-minute default interval", async () => {
    await setupScheduledSync();

    const schedulerCall = mockUpsertJobScheduler.mock.calls[0];
    expect(schedulerCall?.[1].every).toBe(30 * 60 * 1000);
  });

  it("accepts a custom interval in minutes", async () => {
    await setupScheduledSync(15);

    const schedulerCall = mockUpsertJobScheduler.mock.calls[0];
    expect(schedulerCall?.[1].every).toBe(15 * 60 * 1000);
    expect(mockUpsertJobScheduler.mock.calls[1]?.[1].every).toBe(24 * 60 * 60 * 1000);
  });

  it("is idempotent — calling twice uses the same scheduler key", async () => {
    await setupScheduledSync();
    await setupScheduledSync();

    // upsertJobScheduler is idempotent by design (upsert, not insert)
    expect(mockUpsertJobScheduler.mock.calls.map(([key]) => key)).toEqual([
      SCHEDULER_KEY,
      `${SCHEDULER_KEY}-daily`,
      SCHEDULER_KEY,
      `${SCHEDULER_KEY}-daily`,
    ]);
  });
});
