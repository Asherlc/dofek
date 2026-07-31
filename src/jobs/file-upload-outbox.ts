import {
  listPendingFileUploadOutboxRequests,
  markFileUploadOutboxDispatched,
} from "../db/file-upload.ts";
import type { Database } from "../db/typed-sql.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { enqueueFileUploadImport, type FileUploadImportQueue } from "./queues.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export async function dispatchFileUploadOutbox(
  database: Database,
  queue: FileUploadImportQueue,
  limit = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const requests = await listPendingFileUploadOutboxRequests(database, limit);
  for (const request of requests) {
    await enqueueFileUploadImport(request, queue);
    await markFileUploadOutboxDispatched(database, request.uploadId);
  }
  return requests.length;
}

export interface FileUploadOutboxDispatcher {
  close(): Promise<void>;
}

export function startFileUploadOutboxDispatcher(
  database: Database,
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
