import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Database, executeWithSchema } from "./typed-sql.ts";

export const fileUploadImportTypeSchema = z.enum([
  "apple-health",
  "strong-csv",
  "cronometer-csv",
  "kaya-export",
  "zos-app",
  "garmin-dump",
  "fit-file",
]);

export type FileUploadImportType = z.infer<typeof fileUploadImportTypeSchema>;

export const fileUploadStateSchema = z.enum([
  "initiated",
  "uploading",
  "uploaded",
  "queued",
  "processing",
  "completed",
  "failed",
  "aborted",
  "expired",
]);

const fileUploadRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  import_type: fileUploadImportTypeSchema,
  object_key: z.string().min(1),
  original_filename: z.string().min(1),
  content_type: z.string().min(1),
  expected_size_bytes: z.coerce.number().int().positive(),
  expected_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  verified_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  r2_multipart_upload_id: z.string().min(1).nullable(),
  state: fileUploadStateSchema,
  version: z.coerce.number().int().nonnegative(),
  part_size_bytes: z.coerce.number().int().positive(),
  completion_parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
    .nullable(),
  import_job_id: z.string().min(1).nullable(),
  import_since: z.coerce.date(),
  weight_unit: z.enum(["kg", "lbs"]).nullable(),
  timezone: z.string().min(1).nullable(),
  progress_percent: z.coerce.number().int().min(0).max(100),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  completed_at: z.coerce.date().nullable(),
  object_deleted_at: z.coerce.date().nullable(),
});

export interface FileUpload {
  id: string;
  userId: string;
  importType: FileUploadImportType;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  verifiedSha256: string | null;
  r2MultipartUploadId: string | null;
  state: z.infer<typeof fileUploadStateSchema>;
  version: number;
  partSizeBytes: number;
  completionParts: Array<{ partNumber: number; etag: string }> | null;
  importJobId: string | null;
  since: Date;
  weightUnit: "kg" | "lbs" | null;
  /** Client timezone captured when the durable import job was created. */
  timezone?: string | null;
  progressPercent: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  objectDeletedAt: Date | null;
}

export interface CreateFileUploadInput {
  id: string;
  userId: string;
  importType: FileUploadImportType;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  partSizeBytes: number;
  expiresAt: Date;
  since: Date;
  weightUnit?: "kg" | "lbs";
  timezone?: string | null;
}

export interface FileUploadOutboxRequest {
  uploadId: string;
  importJobId: string;
  importType: FileUploadImportType;
  userId: string;
}

export class FileUploadExpiredError extends Error {
  constructor(uploadId: string) {
    super(`Upload ${uploadId} has expired`);
    this.name = "FileUploadExpiredError";
  }
}

const fileUploadOutboxRequestRowSchema = z.object({
  upload_id: z.uuid(),
  import_job_id: z.string().min(1),
  import_type: fileUploadImportTypeSchema,
  user_id: z.uuid(),
});

const selectFileUploadColumns = sql`id, user_id, import_type, object_key,
  original_filename, content_type, expected_size_bytes, expected_sha256,
  verified_sha256, r2_multipart_upload_id, state, version, part_size_bytes, completion_parts,
  import_job_id, import_since, weight_unit, timezone, progress_percent, error_code,
  error_message, created_at, updated_at, expires_at, completed_at, object_deleted_at`;

function mapFileUpload(row: z.infer<typeof fileUploadRowSchema>): FileUpload {
  return {
    id: row.id,
    userId: row.user_id,
    importType: row.import_type,
    objectKey: row.object_key,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    expectedSizeBytes: row.expected_size_bytes,
    expectedSha256: row.expected_sha256,
    verifiedSha256: row.verified_sha256,
    r2MultipartUploadId: row.r2_multipart_upload_id,
    state: row.state,
    version: row.version,
    partSizeBytes: row.part_size_bytes,
    completionParts: row.completion_parts,
    importJobId: row.import_job_id,
    since: row.import_since,
    weightUnit: row.weight_unit,
    timezone: row.timezone,
    progressPercent: row.progress_percent,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    objectDeletedAt: row.object_deleted_at,
  };
}

export async function recordFileUploadCompletionParts(
  database: Database,
  uploadId: string,
  userId: string,
  parts: readonly { partNumber: number; etag: string }[],
): Promise<FileUpload> {
  const serializedParts = JSON.stringify(parts);
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`UPDATE fitness.file_upload
        SET completion_parts = ${serializedParts}::jsonb,
            version = version + 1, updated_at = now()
        WHERE id = ${uploadId}::uuid AND user_id = ${userId}::uuid
          AND state = 'uploading'
          AND expires_at > now()
        RETURNING ${selectFileUploadColumns}`,
  );
  if (rows[0]) return mapFileUpload(rows[0]);
  const existing = await findFileUploadForUser(database, uploadId, userId);
  if (!existing) throw new Error(`Upload ${uploadId} was not found`);
  if (existing.expiresAt <= new Date()) throw new FileUploadExpiredError(uploadId);
  if (
    ["uploaded", "queued", "processing", "completed"].includes(existing.state) &&
    JSON.stringify(existing.completionParts) === serializedParts
  ) {
    return existing;
  }
  throw new Error(`Upload ${uploadId} must be uploading before finalization`);
}

export async function abortFileUpload(
  database: Database,
  uploadId: string,
  userId: string,
): Promise<FileUpload> {
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`UPDATE fitness.file_upload
        SET state = 'aborted', version = version + 1, updated_at = now()
        WHERE id = ${uploadId}::uuid AND user_id = ${userId}::uuid
          AND state IN ('initiated', 'uploading', 'uploaded')
        RETURNING ${selectFileUploadColumns}`,
  );
  if (rows[0]) return mapFileUpload(rows[0]);
  const existing = await findFileUploadForUser(database, uploadId, userId);
  if (!existing) throw new Error(`Upload ${uploadId} was not found`);
  if (existing.state === "aborted") return existing;
  throw new Error(`Upload ${uploadId} cannot be aborted from ${existing.state}`);
}

export async function findFileUploadForUser(
  database: Database,
  uploadId: string,
  userId: string,
): Promise<FileUpload | null> {
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`SELECT ${selectFileUploadColumns}
        FROM fitness.file_upload
        WHERE id = ${uploadId}::uuid AND user_id = ${userId}::uuid
        LIMIT 1`,
  );
  return rows[0] ? mapFileUpload(rows[0]) : null;
}

function assertMatchingInitiation(existing: FileUpload, input: CreateFileUploadInput): void {
  const matches =
    existing.importType === input.importType &&
    existing.objectKey === input.objectKey &&
    existing.originalFilename === input.originalFilename &&
    existing.contentType === input.contentType &&
    existing.expectedSizeBytes === input.expectedSizeBytes &&
    existing.expectedSha256 === input.expectedSha256 &&
    existing.partSizeBytes === input.partSizeBytes &&
    existing.since.getTime() === input.since.getTime() &&
    existing.weightUnit === (input.weightUnit ?? null) &&
    existing.timezone === (input.timezone ?? null);
  if (!matches) {
    throw new Error(`Upload ${input.id} was already initiated with different metadata`);
  }
}

export async function createFileUpload(
  database: Database,
  input: CreateFileUploadInput,
): Promise<FileUpload> {
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`INSERT INTO fitness.file_upload (
          id, user_id, import_type, object_key, original_filename, content_type,
          expected_size_bytes, expected_sha256, part_size_bytes, expires_at,
          import_since, weight_unit, timezone
        ) VALUES (
          ${input.id}::uuid, ${input.userId}::uuid, ${input.importType}, ${input.objectKey},
          ${input.originalFilename}, ${input.contentType}, ${input.expectedSizeBytes},
          ${input.expectedSha256}, ${input.partSizeBytes}, ${input.expiresAt},
          ${input.since}, ${input.weightUnit ?? null}, ${input.timezone ?? null}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING ${selectFileUploadColumns}`,
  );
  const created = rows[0] ? mapFileUpload(rows[0]) : null;
  if (created) return created;

  const existing = await findFileUploadForUser(database, input.id, input.userId);
  if (!existing) throw new Error(`Upload ${input.id} already belongs to another user`);
  assertMatchingInitiation(existing, input);
  return existing;
}

export async function markFileUploadUploading(
  database: Database,
  uploadId: string,
  userId: string,
  multipartUploadId: string,
): Promise<FileUpload> {
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`UPDATE fitness.file_upload
        SET state = 'uploading', r2_multipart_upload_id = ${multipartUploadId},
            version = version + 1, updated_at = now()
        WHERE id = ${uploadId}::uuid AND user_id = ${userId}::uuid
          AND (
            state = 'initiated'
            OR (state = 'uploading' AND r2_multipart_upload_id = ${multipartUploadId})
          )
          AND expires_at > now()
        RETURNING ${selectFileUploadColumns}`,
  );
  if (rows[0]) return mapFileUpload(rows[0]);

  const existing = await findFileUploadForUser(database, uploadId, userId);
  if (!existing) throw new Error(`Upload ${uploadId} was not found`);
  if (existing.expiresAt <= new Date()) throw new FileUploadExpiredError(uploadId);
  throw new Error(`Upload ${uploadId} cannot transition from ${existing.state} to uploading`);
}

export async function queueCompletedFileUpload(
  database: Database,
  uploadId: string,
  userId: string,
  completion: { importJobId: string; objectSizeBytes: number },
): Promise<FileUpload> {
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`WITH queued_upload AS (
          UPDATE fitness.file_upload
          SET state = 'queued', import_job_id = ${completion.importJobId},
              progress_percent = 100, version = version + 1, updated_at = now()
          WHERE id = ${uploadId}::uuid AND user_id = ${userId}::uuid
            AND state = 'uploaded'
            AND expected_size_bytes = ${completion.objectSizeBytes}
            AND expires_at > now()
          RETURNING ${selectFileUploadColumns}
        ), inserted_outbox AS (
          INSERT INTO fitness.file_upload_outbox (upload_id, import_job_id)
          SELECT id, import_job_id FROM queued_upload
          ON CONFLICT (upload_id) DO NOTHING
        )
        SELECT * FROM queued_upload`,
  );
  if (rows[0]) return mapFileUpload(rows[0]);

  const existing = await findFileUploadForUser(database, uploadId, userId);
  if (!existing) throw new Error(`Upload ${uploadId} was not found`);
  if (
    ["queued", "processing", "completed"].includes(existing.state) &&
    existing.importJobId === completion.importJobId
  ) {
    return existing;
  }
  if (existing.expectedSizeBytes !== completion.objectSizeBytes) {
    throw new Error(
      `Upload ${uploadId} size mismatch: expected ${existing.expectedSizeBytes}, received ${completion.objectSizeBytes}`,
    );
  }
  if (existing.expiresAt <= new Date()) throw new FileUploadExpiredError(uploadId);
  throw new Error(`Upload ${uploadId} must be uploaded before queueing`);
}

export async function markFileUploadObjectUploaded(
  database: Database,
  uploadId: string,
  userId: string,
): Promise<FileUpload> {
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`UPDATE fitness.file_upload
        SET state = 'uploaded', version = version + 1, updated_at = now()
        WHERE id = ${uploadId}::uuid AND user_id = ${userId}::uuid
          AND state = 'uploading'
          AND expires_at > now()
        RETURNING ${selectFileUploadColumns}`,
  );
  if (rows[0]) return mapFileUpload(rows[0]);
  const existing = await findFileUploadForUser(database, uploadId, userId);
  if (!existing) throw new Error(`Upload ${uploadId} was not found`);
  if (existing.expiresAt <= new Date()) throw new FileUploadExpiredError(uploadId);
  if (["uploaded", "queued", "processing", "completed"].includes(existing.state)) {
    return existing;
  }
  throw new Error(`Upload ${uploadId} cannot transition from ${existing.state} to uploaded`);
}

export async function listPendingFileUploadOutboxRequests(
  database: Database,
  limit: number,
): Promise<FileUploadOutboxRequest[]> {
  const parsedLimit = z.number().int().positive().max(1_000).parse(limit);
  const rows = await executeWithSchema(
    database,
    fileUploadOutboxRequestRowSchema,
    sql`SELECT outbox.upload_id, outbox.import_job_id, upload.import_type, upload.user_id
        FROM fitness.file_upload_outbox AS outbox
        JOIN fitness.file_upload AS upload ON upload.id = outbox.upload_id
        WHERE outbox.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM fitness.account_erasure_request AS erasure
            WHERE erasure.user_id = upload.user_id
              AND erasure.status <> 'completed'
          )
        ORDER BY outbox.created_at, outbox.event_id
        LIMIT ${parsedLimit}`,
  );
  return rows.map((row) => ({
    uploadId: row.upload_id,
    importJobId: row.import_job_id,
    importType: row.import_type,
    userId: row.user_id,
  }));
}

export async function markFileUploadOutboxDispatched(
  database: Database,
  uploadId: string,
): Promise<void> {
  await database.execute(
    sql`UPDATE fitness.file_upload_outbox
        SET status = 'dispatched', dispatched_at = now(), failure_reason = NULL, failed_at = NULL
        WHERE upload_id = ${uploadId}::uuid AND status = 'pending'`,
  );
}

export async function claimFileUploadForProcessing(
  database: Database,
  uploadId: string,
  importJobId: string,
): Promise<FileUpload> {
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`UPDATE fitness.file_upload
        SET state = 'processing', version = version + 1, updated_at = now()
        WHERE id = ${uploadId}::uuid AND import_job_id = ${importJobId}
          AND state = 'queued'
        RETURNING ${selectFileUploadColumns}`,
  );
  if (rows[0]) return mapFileUpload(rows[0]);
  const existingRows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`SELECT ${selectFileUploadColumns}
        FROM fitness.file_upload
        WHERE id = ${uploadId}::uuid AND import_job_id = ${importJobId}
        LIMIT 1`,
  );
  const existing = existingRows[0] ? mapFileUpload(existingRows[0]) : null;
  if (!existing) throw new Error(`Upload ${uploadId} was not found for job ${importJobId}`);
  if (existing.state === "processing" || existing.state === "completed") return existing;
  throw new Error(`Upload ${uploadId} cannot be processed from ${existing.state}`);
}

export async function updateFileUploadProgress(
  database: Database,
  uploadId: string,
  progressPercent: number,
): Promise<void> {
  const parsedProgress = z.number().int().min(0).max(100).parse(progressPercent);
  await database.execute(
    sql`UPDATE fitness.file_upload
        SET progress_percent = ${parsedProgress}, updated_at = now(), version = version + 1
        WHERE id = ${uploadId}::uuid AND state = 'processing'`,
  );
}

export async function completeFileUploadProcessing(
  database: Database,
  uploadId: string,
  verifiedSha256: string,
): Promise<void> {
  const digest = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(verifiedSha256);
  await database.execute(
    sql`WITH completed_upload AS (
          UPDATE fitness.file_upload
          SET state = 'completed', verified_sha256 = ${digest}, progress_percent = 100,
              completed_at = now(), updated_at = now(), version = version + 1,
              error_code = NULL, error_message = NULL
          WHERE id = ${uploadId}::uuid AND state = 'processing'
            AND expected_sha256 = ${digest}
          RETURNING id
        )
        UPDATE fitness.file_upload_outbox
        SET status = 'completed', completed_at = now(), failure_reason = NULL, failed_at = NULL
        WHERE upload_id IN (SELECT id FROM completed_upload)`,
  );
}

export async function failFileUploadProcessing(
  database: Database,
  uploadId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await database.execute(
    sql`WITH failed_upload AS (
          UPDATE fitness.file_upload
          SET state = 'failed', error_code = ${errorCode}, error_message = ${errorMessage},
              updated_at = now(), version = version + 1
          WHERE id = ${uploadId}::uuid AND state = 'processing'
          RETURNING id
        )
        UPDATE fitness.file_upload_outbox
        SET status = 'failed', failure_reason = ${errorMessage}, failed_at = now()
        WHERE upload_id IN (SELECT id FROM failed_upload)`,
  );
}

export async function listFileUploadsForReconciliation(
  database: Database,
  limit = 500,
): Promise<FileUpload[]> {
  const parsedLimit = z.number().int().positive().max(1_000).parse(limit);
  const rows = await executeWithSchema(
    database,
    fileUploadRowSchema,
    sql`SELECT ${selectFileUploadColumns}
        FROM fitness.file_upload
        WHERE (state IN ('initiated', 'uploading') AND expires_at < now())
           OR state = 'uploaded'
           OR (state = 'processing' AND updated_at < now() - interval '2 hours')
           OR (state IN ('completed', 'failed', 'aborted', 'expired')
               AND updated_at < now() - interval '7 days'
               AND object_deleted_at IS NULL)
        ORDER BY updated_at
        LIMIT ${parsedLimit}`,
  );
  return rows.map(mapFileUpload);
}

export async function markFileUploadObjectDeleted(
  database: Database,
  uploadId: string,
): Promise<void> {
  await database.execute(
    sql`UPDATE fitness.file_upload
        SET object_deleted_at = now(), updated_at = now(), version = version + 1
        WHERE id = ${uploadId}::uuid
          AND state IN ('completed', 'failed', 'aborted', 'expired')
          AND object_deleted_at IS NULL`,
  );
}

export async function expireFileUpload(database: Database, uploadId: string): Promise<boolean> {
  const rows = await executeWithSchema(
    database,
    z.object({ id: z.uuid() }),
    sql`UPDATE fitness.file_upload
        SET state = 'expired', updated_at = now(), version = version + 1
        WHERE id = ${uploadId}::uuid AND state IN ('initiated', 'uploading') AND expires_at < now()
        RETURNING id`,
  );
  return rows.length > 0;
}

export async function requeueStuckFileUpload(
  database: Database,
  uploadId: string,
): Promise<boolean> {
  const rows = await executeWithSchema(
    database,
    z.object({ id: z.uuid() }),
    sql`WITH requeued AS (
          UPDATE fitness.file_upload
          SET state = 'queued', updated_at = now(), version = version + 1
          WHERE id = ${uploadId}::uuid AND state = 'processing'
            AND updated_at < now() - interval '2 hours'
          RETURNING id
        ),
        outbox_update AS (
          UPDATE fitness.file_upload_outbox
          SET status = 'pending', dispatched_at = NULL, failure_reason = NULL, failed_at = NULL
          WHERE upload_id IN (SELECT id FROM requeued)
          RETURNING upload_id
        )
        SELECT id FROM requeued`,
  );
  return rows.length > 0;
}

export async function fileUploadObjectKeyExists(
  database: Database,
  objectKey: string,
): Promise<boolean> {
  const rows = await executeWithSchema(
    database,
    z.object({ exists: z.boolean() }),
    sql`SELECT EXISTS(
          SELECT 1 FROM fitness.file_upload WHERE object_key = ${objectKey}
        ) AS exists`,
  );
  return rows[0]?.exists ?? false;
}

export async function isFileUploadRateAllowed(
  database: Database,
  userId: string,
  operation: "initiate" | "complete",
): Promise<boolean> {
  const rows = await executeWithSchema(
    database,
    z.object({ allowed: z.boolean() }),
    operation === "initiate"
      ? sql`SELECT count(*) < 10 AS allowed
            FROM fitness.file_upload
            WHERE user_id = ${userId}::uuid AND created_at > now() - interval '1 minute'`
      : sql`SELECT count(*) < 10 AS allowed
            FROM fitness.file_upload
            WHERE user_id = ${userId}::uuid
              AND state IN ('uploaded', 'queued', 'processing', 'completed')
              AND updated_at > now() - interval '1 minute'`,
  );
  return rows[0]?.allowed ?? false;
}
