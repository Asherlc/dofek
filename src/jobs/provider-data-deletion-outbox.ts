import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "../db/account-erasure.ts";
import type { Database } from "../db/index.ts";
import {
  listPendingProviderDataDeletionRequests,
  markProviderDataDeletionDispatched,
} from "../db/provider-data-deletion.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { enqueueProviderDataDeletion, type ProviderDataDeletionQueue } from "./queues.ts";

const DEFAULT_OUTBOX_BATCH_SIZE = 100;
const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 5_000;

export async function dispatchProviderDataDeletionOutbox(
  database: Pick<Database, "execute" | "transaction">,
  queue: ProviderDataDeletionQueue,
  limit = DEFAULT_OUTBOX_BATCH_SIZE,
): Promise<number> {
  const requests = await listPendingProviderDataDeletionRequests(database, limit);
  let dispatched = 0;
  for (const request of requests) {
    try {
      await withAccountErasureUserWriteFence(database, request.userId, async (transaction) => {
        await enqueueProviderDataDeletion(request, queue);
        await markProviderDataDeletionDispatched(transaction, request.eventId);
      });
      dispatched++;
    } catch (error: unknown) {
      if (!(error instanceof AccountErasureUserFencedError)) throw error;
    }
  }
  return dispatched;
}

export interface ProviderDataDeletionOutboxDispatcher {
  close(): Promise<void>;
}

export function startProviderDataDeletionOutboxDispatcher(
  database: Pick<Database, "execute" | "transaction">,
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
