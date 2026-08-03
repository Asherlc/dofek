import {
  expireFileUpload,
  fileUploadObjectKeyExists,
  listFileUploadsForReconciliation,
  markFileUploadObjectDeleted,
  queueCompletedFileUpload,
  requeueStuckFileUpload,
} from "../db/file-upload.ts";
import type { Database } from "../db/typed-sql.ts";
import { fileUploadLifecycleTotal, fileUploadReconciliationTotal } from "../file-upload-metrics.ts";
import type { ImportUploadStorage } from "../file-upload-storage.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";

const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1_000;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;

function reportReconciliationItemFailure(
  error: unknown,
  repairKind: "upload" | "orphan",
  extra: { uploadId: string } | { objectKey: string },
): void {
  captureException(error, {
    tags: { source: "file-upload-reconciliation", repairKind },
    extra,
  });
  logger.error(
    `[file-upload-reconciliation] Failed ${repairKind} repair (${Object.values(extra)[0]}): ${String(error)}`,
  );
}

export async function reconcileFileUploads(
  database: Database,
  storage: ImportUploadStorage,
): Promise<void> {
  const uploads = await listFileUploadsForReconciliation(database);
  for (const upload of uploads) {
    try {
      if (
        (upload.state === "initiated" || upload.state === "uploading") &&
        upload.expiresAt < new Date()
      ) {
        if (upload.r2MultipartUploadId) {
          try {
            await storage.abortMultipartUpload(upload.objectKey, upload.r2MultipartUploadId);
          } catch (abortError: unknown) {
            captureException(abortError, {
              tags: {
                source: "file-upload-reconciliation",
                repairKind: "completed_multipart",
              },
              extra: { uploadId: upload.id },
            });
            await storage.headObject(upload.objectKey);
            await storage.deleteObject(upload.objectKey);
            fileUploadReconciliationTotal.add(1, {
              repair: "completed_multipart_object",
            });
          }
        }
        if (await expireFileUpload(database, upload.id)) {
          fileUploadLifecycleTotal.add(1, { state: "expired", import_type: upload.importType });
          fileUploadReconciliationTotal.add(1, { repair: "expired_multipart" });
        }
        continue;
      }
      if (upload.state === "uploaded") {
        const object = await storage.headObject(upload.objectKey);
        await queueCompletedFileUpload(database, upload.id, upload.userId, {
          importJobId: `file-import-${upload.id}`,
          objectSizeBytes: object.sizeBytes,
        });
        fileUploadReconciliationTotal.add(1, { repair: "uploaded_without_outbox" });
        continue;
      }
      if (upload.state === "processing") {
        if (await requeueStuckFileUpload(database, upload.id)) {
          fileUploadReconciliationTotal.add(1, { repair: "stuck_processing" });
        }
        continue;
      }
      await storage.deleteObject(upload.objectKey);
      await markFileUploadObjectDeleted(database, upload.id);
    } catch (error) {
      reportReconciliationItemFailure(error, "upload", { uploadId: upload.id });
    }
  }

  const orphanCutoff = Date.now() - ORPHAN_GRACE_MS;
  for (const object of await storage.listObjects("imports/")) {
    try {
      if (
        object.lastModified.getTime() < orphanCutoff &&
        !(await fileUploadObjectKeyExists(database, object.objectKey))
      ) {
        await storage.deleteObject(object.objectKey);
        fileUploadReconciliationTotal.add(1, { repair: "orphaned_object" });
      }
    } catch (error) {
      reportReconciliationItemFailure(error, "orphan", { objectKey: object.objectKey });
    }
  }
}

export interface FileUploadReconciler {
  close(): Promise<void>;
}

export function startFileUploadReconciler(
  database: Database,
  storage: ImportUploadStorage,
): FileUploadReconciler {
  let running: Promise<void> | null = null;
  let closed = false;
  const run = () => {
    if (closed || running) return;
    running = reconcileFileUploads(database, storage)
      .catch((error: unknown) => {
        captureException(error, { tags: { source: "file-upload-reconciliation" } });
        logger.error(`[file-upload-reconciliation] Failed: ${String(error)}`);
      })
      .finally(() => {
        running = null;
      });
  };
  run();
  const timer = setInterval(run, RECONCILIATION_INTERVAL_MS);
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
