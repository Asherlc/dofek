import { captureException } from "../lib/error-reporting.ts";
import {
  listPendingProviderDataDeletionRequests,
  markProviderDataDeletionDispatched,
} from "../db/provider-data-deletion.ts";
import type { Database } from "../db/typed-sql.ts";
import { logger } from "../logger.ts";
import { enqueueProviderDataDeletion, type ProviderDataDeletionQueue } from "./queues.ts";

const DEFAULT_OUTBOX_BATCH_SIZE = 100;
const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 5_000;

export async function dispatchProviderDataDeletionOutbox(
  database: Database,
  queue: ProviderDataDeletionQueue,
  limit = DEFAULT_OUTBOX_BATCH_SIZE,
): Promise<number> {
  const requests = await listPendingProviderDataDeletionRequests(database, limit);
  for (const request of requests) {
    await enqueueProviderDataDeletion(request, queue);
    await markProviderDataDeletionDispatched(database, request.eventId);
  }
  return requests.length;
}

export interface ProviderDataDeletionOutboxDispatcher {
  close(): Promise<void>;
}

export function startProviderDataDeletionOutboxDispatcher(
  database: Database,
  queue: ProviderDataDeletionQueue,
  pollIntervalMs = DEFAULT_OUTBOX_POLL_INTERVAL_MS,
): ProviderDataDeletionOutboxDispatcher {
  let closed = false;
  let dispatchPromise: Promise<void> | null = null;

  const dispatch = (): void => {
    if (closed || dispatchPromise) return;
    dispatchPromise = dispatchProviderDataDeletionOutbox(database, queue)
      .then((count) => {
        if (count > 0) {
          logger.info(`[provider-data-deletion-outbox] Dispatched ${count} request(s)`);
        }
      })
      .catch((error: unknown) => {
        captureException(error, { tags: { source: "provider-data-deletion-outbox" } });
        logger.error(`[provider-data-deletion-outbox] Dispatch failed: ${String(error)}`);
      })
      .finally(() => {
        dispatchPromise = null;
      });
  };

  dispatch();
  const timer = setInterval(dispatch, pollIntervalMs);

  return {
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await dispatchPromise;
    },
  };
}
