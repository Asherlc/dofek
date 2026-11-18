import { describe, expect, it } from "vitest";
import { createScheduledSyncQueue } from "./queues.ts";
import { SCHEDULER_KEY, setupScheduledSync } from "./scheduled-sync.ts";

describe("scheduled sync registration", () => {
  it("keeps the daily scheduler off the queue consumed by older workers", async () => {
    const regularQueue = createScheduledSyncQueue();
    const dailyQueue = createScheduledSyncQueue(undefined, "daily");
    const dailyKey = `${SCHEDULER_KEY}-daily`;

    try {
      await setupScheduledSync(15);

      await expect(regularQueue.getJobScheduler(SCHEDULER_KEY)).resolves.toMatchObject({
        every: 900_000,
      });
      await expect(regularQueue.getJobScheduler(dailyKey)).resolves.toBeUndefined();
      await expect(dailyQueue.getJobScheduler(dailyKey)).resolves.toMatchObject({
        every: 86_400_000,
        template: { data: { cadence: "daily", type: "scheduled-sync-all" } },
      });
    } finally {
      await regularQueue.removeJobScheduler(SCHEDULER_KEY);
      await dailyQueue.removeJobScheduler(dailyKey);
      await Promise.all([regularQueue.close(), dailyQueue.close()]);
    }
  });
});
