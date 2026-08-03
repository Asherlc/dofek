import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "../db/account-erasure.ts";
import {
  listPendingFileUploadOutboxRequests,
  markFileUploadOutboxDispatched,
} from "../db/file-upload.ts";
import type { Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { enqueueFileUploadImport, type FileUploadImportQueue } from "./queues.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export async function dispatchFileUploadOutbox(
  database: Pick<Database, "execute" | "transaction">,
  queue: FileUploadImportQueue,
  limit = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const requests = await listPendingFileUploadOutboxRequests(database, limit);
  let dispatched = 0;
  for (const request of requests) {
    try {
      await withAccountErasureUserWriteFence(database, request.userId, async (transaction) => {
        await enqueueFileUploadImport(request, queue);
        await markFileUploadOutboxDispatched(transaction, request.uploadId);
      });
      dispatched++;
    } catch (error: unknown) {
      if (!(error instanceof AccountErasureUserFencedError)) throw error;
    }
  }
  return dispatched;
}

export interface FileUploadOutboxDispatcher {
  close(): Promise<void>;
}

export function startFileUploadOutboxDispatcher(
  database: Pick<Database, "execute" | "transaction">,
  queue: FileUploadImportQueue,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): FileUploadOutboxDispatcher {
  let closed = false;
  let dispatchPromise: Promise<void> | null = null;
  const dispatch = (): void => {
    if (closed || dispatchPromise) return;
    dispatchPromise = dispatchFileUploadOutbox(database, queue)
      .then((count) => {
        if (count > 0) logger.info(`[file-upload-outbox] Dispatched ${count} upload(s)`);
      })
      .catch((error: unknown) => {
        captureException(error, { tags: { source: "file-upload-outbox" } });
        logger.error(`[file-upload-outbox] Dispatch failed: ${String(error)}`);
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
