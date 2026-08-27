import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpsertJobScheduler = vi.fn().mockResolvedValue({});

vi.mock("./queues.ts", () => ({
  createScheduledSyncQueue: vi.fn(() => ({
    upsertJobScheduler: mockUpsertJobScheduler,
  })),
  SCHEDULED_SYNC_QUEUE: "scheduled-sync",
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES,
  SCHEDULER_KEY,
  setupScheduledSync,
} from "./scheduled-sync.ts";

describe("setupScheduledSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a repeatable job scheduler with the correct key and template", async () => {
    await setupScheduledSync();

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      SCHEDULER_KEY,
      expect.objectContaining({ every: expect.any(Number) }),
      {
        name: "scheduled-sync",
        data: { type: "scheduled-sync-all" },
      },
    );
  });

  it("uses the exported 30-minute default interval", async () => {
    expect(DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES).toBe(30);

    await setupScheduledSync();

    const schedulerCall = mockUpsertJobScheduler.mock.calls[0];
    expect(schedulerCall?.[1].every).toBe(DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES * 60 * 1000);
  });

  it("accepts a custom interval in minutes", async () => {
    await setupScheduledSync(15);

    const schedulerCall = mockUpsertJobScheduler.mock.calls[0];
    expect(schedulerCall?.[1].every).toBe(15 * 60 * 1000);
  });

  it("is idempotent — calling twice uses the same scheduler key", async () => {
    await setupScheduledSync();
    await setupScheduledSync();

    // upsertJobScheduler is idempotent by design (upsert, not insert)
    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(mockUpsertJobScheduler.mock.calls[0]?.[0]).toBe(SCHEDULER_KEY);
    expect(mockUpsertJobScheduler.mock.calls[1]?.[0]).toBe(SCHEDULER_KEY);
  });
});
