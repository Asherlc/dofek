import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import {
  type FileUpload,
  findFileUploadForUser,
  retryFailedFileUpload,
  withLockedFileUpload,
} from "../src/db/file-upload.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { createImportUploadStorageFromEnv } from "../src/file-upload-storage.ts";
import { captureException } from "../src/lib/error-reporting.ts";

interface RetryFailedFileUploadCommand {
  execute: boolean;
  uploadId: string;
  userId: string;
  importJobId?: string;
  weightUnit?: "kg" | "lbs";
  timezone?: string;
}

function requireValidIanaTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`timezone must be a valid IANA timezone: ${timezone}`);
  }
  return timezone;
}

function requiredUuid(value: string | undefined, option: string): string {
  return z.uuid({ error: `${option} is required and must be a UUID` }).parse(value);
}

export function parseRetryFailedFileUploadCommand(
  args: readonly string[],
): RetryFailedFileUploadCommand {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "upload-id": { type: "string" },
      "user-id": { type: "string" },
      "job-id": { type: "string" },
      "weight-unit": { type: "string" },
      timezone: { type: "string" },
      execute: { type: "boolean", default: false },
    },
  });
  const execute = values.execute;
  const importJobId = values["job-id"]?.trim();
  if (execute && !importJobId) throw new Error("--job-id is required with --execute");
  const weightUnit = values["weight-unit"]
    ? z
        .enum(["kg", "lbs"], { error: "--weight-unit must be kg or lbs" })
        .parse(values["weight-unit"])
    : undefined;
  const timezone =
    values.timezone == null
      ? undefined
      : z.string().trim().min(1, "--timezone must not be blank").parse(values.timezone);
  if (timezone) {
    requireValidIanaTimezone(timezone);
  }
  return {
    execute,
    uploadId: requiredUuid(values["upload-id"], "--upload-id"),
    userId: requiredUuid(values["user-id"], "--user-id"),
    ...(importJobId ? { importJobId } : {}),
    ...(weightUnit ? { weightUnit } : {}),
    ...(timezone ? { timezone } : {}),
  };
}

function validateRetainedRetry(
  upload: FileUpload,
  command: RetryFailedFileUploadCommand,
): { weightUnit: "kg" | "lbs" | null; timezone: string | null } {
  const isIdempotentExecute =
    command.execute && upload.state === "queued" && upload.importJobId === command.importJobId;
  if (upload.state !== "failed" && !isIdempotentExecute) {
    throw new Error(`Upload ${upload.id} cannot be retried from ${upload.state}`);
  }
  if (upload.objectDeletedAt) throw new Error(`Upload ${upload.id} source object was deleted`);
  const weightUnit = command.weightUnit ?? upload.weightUnit;
  const timezone = command.timezone ?? upload.timezone ?? null;
  if (upload.importType === "strong-csv") {
    if (!command.weightUnit) throw new Error("Strong CSV retry requires an explicit weight unit");
    if (!command.timezone) throw new Error("Strong CSV retry requires an explicit timezone");
  }
  if (timezone) requireValidIanaTimezone(timezone);
  return { weightUnit, timezone };
}

function initializeSentry(): void {
  const dsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (dsn) Sentry.init({ dsn, skipOpenTelemetrySetup: true });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  initializeSentry();
  const command = parseRetryFailedFileUploadCommand(args);
  const database = createDatabaseFromEnv();
  try {
    const upload = await findFileUploadForUser(database, command.uploadId, command.userId);
    if (!upload) throw new Error(`Upload ${command.uploadId} was not found for the requested user`);
    const corrected = validateRetainedRetry(upload, command);
    const storage = createImportUploadStorageFromEnv();
    const object = await storage.headObject(upload.objectKey);
    if (object.sizeBytes !== upload.expectedSizeBytes) {
      throw new Error(
        `Upload ${upload.id} source size changed: expected ${upload.expectedSizeBytes}, found ${object.sizeBytes}`,
      );
    }

    if (!command.execute) {
      console.log(
        JSON.stringify({
          kind: "dry-run",
          uploadId: upload.id,
          importType: upload.importType,
          retainedSourceBytes: object.sizeBytes,
          corrected,
        }),
      );
      console.log(
        "[file-upload-retry] dry run only; add --execute with a stable --job-id to queue",
      );
      return;
    }
    const importJobId = command.importJobId;
    if (!importJobId) throw new Error("--job-id is required with --execute");
    const retried = await withLockedFileUpload(
      database,
      command.uploadId,
      async (transaction, locked) => {
        if (locked.userId !== command.userId) {
          throw new Error(`Upload ${command.uploadId} was not found for the requested user`);
        }
        const lockedCorrection = validateRetainedRetry(locked, command);
        const lockedObject = await storage.headObject(locked.objectKey);
        if (lockedObject.sizeBytes !== locked.expectedSizeBytes) {
          throw new Error(
            `Upload ${locked.id} source size changed: expected ${locked.expectedSizeBytes}, found ${lockedObject.sizeBytes}`,
          );
        }
        return retryFailedFileUpload(transaction, {
          uploadId: command.uploadId,
          userId: command.userId,
          importJobId,
          ...(lockedCorrection.weightUnit ? { weightUnit: lockedCorrection.weightUnit } : {}),
          ...(lockedCorrection.timezone ? { timezone: lockedCorrection.timezone } : {}),
        });
      },
    );
    console.log(
      JSON.stringify({
        kind: "execute",
        uploadId: retried.id,
        importType: retried.importType,
        state: retried.state,
        importJobId: retried.importJobId,
        corrected,
      }),
    );
  } catch (error: unknown) {
    captureException(error);
    throw error;
  } finally {
    await database.$client.end();
    await Sentry.close(2_000);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[file-upload-retry] ${String(error)}`);
    process.exit(1);
  });
}
