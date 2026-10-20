import type { JobsOptions } from "bullmq";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "../db/account-erasure.ts";
import {
  type ActivityImageDatabase,
  listPendingActivityImageWork,
  markActivityImageDispatched,
  reconcileActivityImageWork,
} from "../db/activity-images.ts";
import { captureException } from "../lib/error-reporting.ts";
export interface ActivityImageQueue {
  add(
    name: string,
    data: { workId: string; userId: string } | { backfillId: string; userId: string },
    options?: JobsOptions,
  ): Promise<unknown>;
}
export async function dispatchActivityImageOutbox(
  db: ActivityImageDatabase,
  queue: ActivityImageQueue,
  limit = 100,
): Promise<number> {
  const pending = await listPendingActivityImageWork(db, limit);
  let count = 0;
  for (const work of pending) {
    try {
      await withAccountErasureUserWriteFence(db, work.userId, async (tx) => {
        await queue.add(
          "acquire",
          { workId: work.id, userId: work.userId },
          { jobId: `activity-image-${work.id}`, removeOnComplete: true, removeOnFail: 100 },
        );
        await markActivityImageDispatched(tx, work.id);
      });
      count++;
    } catch (error) {
      if (!(error instanceof AccountErasureUserFencedError)) throw error;
    }
  }
  return count;
}
export function startActivityImageOutboxDispatcher(
  db: ActivityImageDatabase,
  queue: ActivityImageQueue,
  reconcile: () => Promise<void>,
  dispatchBackfills: () => Promise<void>,
): { close(): Promise<void> } {
  let closed = false;
  let active: Promise<void> | null = null;
  let lastReconcile = 0;
  const tick = () => {
    if (closed || active) return;
    active = (async () => {
      if (Date.now() - lastReconcile >= 300_000) {
        await reconcileActivityImageWork(db);
        await reconcile();
        lastReconcile = Date.now();
      }
      await dispatchActivityImageOutbox(db, queue);
      await dispatchBackfills();
    })()
      .catch((error: unknown) => {
        captureException(error, { tags: { source: "activity-image-outbox" } });
      })
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, 5000);
  tick();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
