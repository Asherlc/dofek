import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "../db/account-erasure.ts";
import { listQueuedDataExportRequests } from "../db/data-export.ts";
import type { Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { type DataExportQueue, enqueueDataExport } from "./queues.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export async function dispatchDataExportOutbox(
  database: Pick<Database, "execute" | "transaction">,
  queue: DataExportQueue,
  limit = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const requests = await listQueuedDataExportRequests(database, limit);
  let dispatched = 0;
  for (const request of requests) {
    try {
      await withAccountErasureUserWriteFence(database, request.userId, async () => {
        await enqueueDataExport(request, queue);
      });
      dispatched++;
    } catch (error: unknown) {
      if (!(error instanceof AccountErasureUserFencedError)) throw error;
    }
  }
  return dispatched;
}

export interface DataExportOutboxDispatcher {
  close(): Promise<void>;
}

export function startDataExportOutboxDispatcher(
  database: Pick<Database, "execute" | "transaction">,
  queue: DataExportQueue,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): DataExportOutboxDispatcher {
  let dispatchPromise: Promise<void> | null = null;
  const dispatch = (): void => {
    if (dispatchPromise) return;
    dispatchPromise = dispatchDataExportOutbox(database, queue)
      .then((count) => {
        if (count > 0) {
          logger.info(`[data-export-outbox] Ensured ${count} queued export(s)`);
        }
      })
      .catch((error: unknown) => {
        captureException(error, { tags: { source: "data-export-outbox" } });
        logger.error(`[data-export-outbox] Dispatch failed: ${String(error)}`);
      })
      .finally(() => {
        dispatchPromise = null;
      });
  };
  dispatch();
  const timer = setInterval(dispatch, pollIntervalMs);
  return {
    async close(): Promise<void> {
      clearInterval(timer);
      await dispatchPromise;
    },
  };
}
