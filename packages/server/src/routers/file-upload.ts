import { extname } from "node:path";
import { TRPCError } from "@trpc/server";
import type { Database, TransactionDatabase } from "dofek/db";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import {
  abortFileUpload,
  type CreateFileUploadInput,
  createFileUpload,
  type FileUpload,
  FileUploadExpiredError,
  fileUploadImportTypeSchema,
  fileUploadStateSchema,
  findFileUploadForUser,
  isFileUploadRateAllowed,
  markFileUploadObjectUploaded,
  markFileUploadUploading,
  queueCompletedFileUpload,
  recordFileUploadCompletionParts,
} from "dofek/db/file-upload";
import {
  fileUploadBytesTotal,
  fileUploadCompletionDuration,
  fileUploadLifecycleTotal,
} from "dofek/file-upload-metrics";
import {
  createImportUploadStorageFromEnv,
  type ImportUploadStorage,
} from "dofek/file-upload-storage";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

const DEFAULT_PART_SIZE_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PART_COUNT = 10_000;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const importConfig = {
  "apple-health": {
    extensions: [".zip", ".xml"],
    contentTypes: ["application/octet-stream", "application/zip", "application/xml", "text/xml"],
  },
  "strong-csv": {
    extensions: [".csv"],
    contentTypes: ["text/csv", "application/octet-stream", "text/plain"],
  },
  "cronometer-csv": {
    extensions: [".csv"],
    contentTypes: ["text/csv", "application/octet-stream", "text/plain"],
  },
  "kaya-export": {
    extensions: [".csv"],
    contentTypes: ["text/csv", "application/octet-stream", "text/plain"],
  },
  "zos-app": {
    extensions: [".bin"],
    contentTypes: ["application/octet-stream"],
  },
  "garmin-dump": {
    extensions: [".zip"],
    contentTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
  },
  "fit-file": {
    extensions: [".fit"],
    contentTypes: ["application/octet-stream"],
  },
} satisfies Record<z.infer<typeof fileUploadImportTypeSchema>, ImportValidationConfig>;

interface ImportValidationConfig {
  extensions: readonly string[];
  contentTypes: readonly string[];
}

export interface FileUploadRepository {
  abort(database: TransactionDatabase, uploadId: string, userId: string): Promise<FileUpload>;
  create(database: TransactionDatabase, input: CreateFileUploadInput): Promise<FileUpload>;
  find(database: TransactionDatabase, uploadId: string, userId: string): Promise<FileUpload | null>;
  markUploading(
    database: TransactionDatabase,
    uploadId: string,
    userId: string,
    multipartUploadId: string,
  ): Promise<FileUpload>;
  markUploaded(
    database: TransactionDatabase,
    uploadId: string,
    userId: string,
  ): Promise<FileUpload>;
  queue(
    database: TransactionDatabase,
    uploadId: string,
    userId: string,
    completion: { importJobId: string; objectSizeBytes: number },
  ): Promise<FileUpload>;
  recordCompletionParts(
    database: TransactionDatabase,
    uploadId: string,
    userId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<FileUpload>;
  rateAllowed(
    database: TransactionDatabase,
    userId: string,
    operation: "initiate" | "complete",
  ): Promise<boolean>;
}

interface FileUploadRouterDependencies {
  repository: FileUploadRepository;
  storage?: ImportUploadStorage;
  withUserWriteFence<T>(
    database: Pick<Database, "transaction">,
    userId: string,
    operation: (transaction: TransactionDatabase) => Promise<T>,
  ): Promise<T>;
}

const defaultRepository: FileUploadRepository = {
  abort: abortFileUpload,
  create: createFileUpload,
  find: findFileUploadForUser,
  markUploading: markFileUploadUploading,
  markUploaded: markFileUploadObjectUploaded,
  queue: queueCompletedFileUpload,
  recordCompletionParts: recordFileUploadCompletionParts,
  rateAllowed: isFileUploadRateAllowed,
};

let defaultStorage: ImportUploadStorage | null = null;

function storageFor(dependencies: FileUploadRouterDependencies): ImportUploadStorage {
  if (dependencies.storage) return dependencies.storage;
  defaultStorage ??= createImportUploadStorageFromEnv();
  return defaultStorage;
}

function serializeUpload(upload: FileUpload) {
  return {
    uploadId: upload.id,
    importType: upload.importType,
    state: upload.state,
    expectedSizeBytes: upload.expectedSizeBytes,
    partSizeBytes: upload.partSizeBytes,
    partCount: Math.ceil(upload.expectedSizeBytes / upload.partSizeBytes),
    progressPercent: upload.progressPercent,
    importJobId: upload.importJobId,
    errorMessage: upload.errorMessage,
    expiresAt: upload.expiresAt.toISOString(),
  };
}

function requireUpload(upload: FileUpload | null, uploadId: string): FileUpload {
  if (!upload) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Upload ${uploadId} was not found` });
  }
  return upload;
}

function requireActiveUpload(upload: FileUpload): FileUpload {
  if (upload.expiresAt <= new Date()) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Upload session has expired" });
  }
  return upload;
}

async function translateExpiredUploadError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FileUploadExpiredError) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Upload session has expired" });
    }
    throw error;
  }
}

function objectKey(userId: string, uploadId: string): string {
  return `imports/${userId}/${uploadId}/source`;
}

function validateImportMetadata(input: z.infer<typeof initiateInputSchema>): void {
  const config = importConfig[input.importType];
  const extension = extname(input.filename).toLowerCase();
  if (!config.extensions.includes(extension)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid ${input.importType} file extension`,
    });
  }
  const baseContentType = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!config.contentTypes.includes(baseContentType)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid ${input.importType} content type`,
    });
  }
}

function partLength(upload: FileUpload, partNumber: number): number {
  const partCount = Math.ceil(upload.expectedSizeBytes / upload.partSizeBytes);
  if (partNumber < 1 || partNumber > partCount) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid upload part ${partNumber}` });
  }
  if (partNumber < partCount) return upload.partSizeBytes;
  return upload.expectedSizeBytes - upload.partSizeBytes * (partCount - 1);
}

function normalizeEtag(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

function verifyParts(
  upload: FileUpload,
  authoritativeParts: readonly { partNumber: number; etag: string; sizeBytes: number }[],
  submittedParts: readonly { partNumber: number; etag: string }[],
): Array<{ partNumber: number; etag: string }> {
  const expectedPartCount = Math.ceil(upload.expectedSizeBytes / upload.partSizeBytes);
  const ordered = [...authoritativeParts].sort(
    (first, second) => first.partNumber - second.partNumber,
  );
  if (ordered.length !== expectedPartCount) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Upload has incomplete parts" });
  }
  const submittedByNumber = new Map(submittedParts.map((part) => [part.partNumber, part.etag]));
  for (let index = 0; index < ordered.length; index++) {
    const part = ordered[index];
    const expectedPartNumber = index + 1;
    if (!part || part.partNumber !== expectedPartNumber) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Upload part numbers must be consecutive",
      });
    }
    if (part.sizeBytes !== partLength(upload, part.partNumber)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Upload part ${part.partNumber} has invalid size`,
      });
    }
    const submittedEtag = submittedByNumber.get(part.partNumber);
    if (!submittedEtag || normalizeEtag(submittedEtag) !== normalizeEtag(part.etag)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Upload part ${part.partNumber} ETag mismatch`,
      });
    }
  }
  return ordered.map((part) => ({ partNumber: part.partNumber, etag: part.etag }));
}

const initiateInputSchema = z.object({
  uploadId: z.uuid(),
  importType: fileUploadImportTypeSchema,
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fullSync: z.boolean().optional(),
  weightUnit: z.enum(["kg", "lbs"]).optional(),
});

const uploadIdInputSchema = z.object({ uploadId: z.uuid() });
const completedPartSchema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().min(1),
});
const serializedUploadSchema = z.object({
  uploadId: z.uuid(),
  importType: fileUploadImportTypeSchema,
  state: fileUploadStateSchema,
  expectedSizeBytes: z.number().int().positive(),
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
  progressPercent: z.number().int().min(0).max(100),
  importJobId: z.string().min(1).nullable(),
  errorMessage: z.string().nullable(),
  expiresAt: z.string().datetime(),
});
const authorizedPartSchema = z.object({
  partNumber: z.number().int().positive(),
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
const uploadedPartSchema = completedPartSchema.extend({
  sizeBytes: z.number().int().positive(),
});

export function createFileUploadRouter(dependencies: FileUploadRouterDependencies) {
  return router({
    initiate: protectedProcedure
      .input(initiateInputSchema)
      .output(serializedUploadSchema)
      .mutation(async ({ ctx, input }) => {
        validateImportMetadata(input);
        const partCount = Math.ceil(input.sizeBytes / DEFAULT_PART_SIZE_BYTES);
        if (partCount > MAX_PART_COUNT) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Upload has too many parts" });
        }
        const remoteSideEffect: {
          createdMultipart: {
            multipartUploadId: string;
            objectKey: string;
            uploadId: string;
          } | null;
        } = { createdMultipart: null };
        try {
          return await dependencies.withUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
            const existingUpload = await dependencies.repository.find(
              transaction,
              input.uploadId,
              ctx.userId,
            );
            const isIncrementalAppleHealth =
              input.importType === "apple-health" && input.fullSync !== true;
            const existingIncrementalSince =
              existingUpload?.importType === "apple-health" && existingUpload.since.getTime() !== 0
                ? existingUpload.since
                : null;
            const since = isIncrementalAppleHealth
              ? (existingIncrementalSince ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
              : new Date(0);
            if (
              !existingUpload &&
              !(await dependencies.repository.rateAllowed(transaction, ctx.userId, "initiate"))
            ) {
              throw new TRPCError({
                code: "TOO_MANY_REQUESTS",
                message: "Too many uploads initiated; try again shortly",
              });
            }
            let upload = await dependencies.repository.create(transaction, {
              id: input.uploadId,
              userId: ctx.userId,
              importType: input.importType,
              objectKey: objectKey(ctx.userId, input.uploadId),
              originalFilename: input.filename,
              contentType: input.contentType.toLowerCase(),
              expectedSizeBytes: input.sizeBytes,
              expectedSha256: input.sha256,
              partSizeBytes: DEFAULT_PART_SIZE_BYTES,
              expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
              since,
              weightUnit:
                input.importType === "strong-csv" ? (input.weightUnit ?? "kg") : undefined,
            });
            if (!existingUpload) {
              fileUploadLifecycleTotal.add(1, {
                state: "initiated",
                import_type: input.importType,
              });
            }
            if (upload.state === "initiated") {
              const multipartUploadId = await storageFor(dependencies).createMultipartUpload(
                upload.objectKey,
                upload.contentType,
              );
              remoteSideEffect.createdMultipart = {
                multipartUploadId,
                objectKey: upload.objectKey,
                uploadId: upload.id,
              };
              try {
                upload = await translateExpiredUploadError(() =>
                  dependencies.repository.markUploading(
                    transaction,
                    upload.id,
                    ctx.userId,
                    multipartUploadId,
                  ),
                );
              } catch (error) {
                try {
                  await storageFor(dependencies).abortMultipartUpload(
                    upload.objectKey,
                    multipartUploadId,
                  );
                  remoteSideEffect.createdMultipart = null;
                } catch (abortError) {
                  captureException(abortError, {
                    tags: {
                      source: "file-upload-initiate",
                      operation: "abortMultipartUpload",
                    },
                    extra: { uploadId: upload.id, multipartUploadId },
                  });
                }
                const concurrentUpload = await dependencies.repository.find(
                  transaction,
                  upload.id,
                  ctx.userId,
                );
                if (
                  concurrentUpload?.state === "uploading" &&
                  concurrentUpload.r2MultipartUploadId
                ) {
                  upload = concurrentUpload;
                } else {
                  throw error;
                }
              }
            }
            return serializeUpload(upload);
          });
        } catch (error: unknown) {
          if (remoteSideEffect.createdMultipart) {
            const createdMultipart = remoteSideEffect.createdMultipart;
            try {
              await storageFor(dependencies).abortMultipartUpload(
                createdMultipart.objectKey,
                createdMultipart.multipartUploadId,
              );
            } catch (abortError: unknown) {
              captureException(abortError, {
                tags: {
                  source: "file-upload-initiate",
                  operation: "abortMultipartUpload",
                },
                extra: {
                  uploadId: createdMultipart.uploadId,
                  multipartUploadId: createdMultipart.multipartUploadId,
                },
              });
            }
          }
          throw error;
        }
      }),

    authorizeParts: protectedProcedure
      .input(
        uploadIdInputSchema.extend({
          partNumbers: z.array(z.number().int().positive()).min(1).max(100),
        }),
      )
      .output(z.object({ upload: serializedUploadSchema, parts: z.array(authorizedPartSchema) }))
      .mutation(async ({ ctx, input }) => {
        return dependencies.withUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
          const upload = requireActiveUpload(
            requireUpload(
              await dependencies.repository.find(transaction, input.uploadId, ctx.userId),
              input.uploadId,
            ),
          );
          if (upload.state !== "uploading" || !upload.r2MultipartUploadId) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Upload is not accepting parts",
            });
          }
          const uniquePartNumbers = [...new Set(input.partNumbers)];
          const parts = await Promise.all(
            uniquePartNumbers.map((partNumber) =>
              storageFor(dependencies).authorizeUploadPart({
                objectKey: upload.objectKey,
                multipartUploadId: upload.r2MultipartUploadId ?? "",
                partNumber,
                contentLength: partLength(upload, partNumber),
              }),
            ),
          );
          return { upload: serializeUpload(upload), parts };
        });
      }),

    resume: protectedProcedure
      .input(uploadIdInputSchema)
      .output(z.object({ upload: serializedUploadSchema, parts: z.array(uploadedPartSchema) }))
      .query(async ({ ctx, input }) => {
        const upload = requireUpload(
          await dependencies.repository.find(ctx.db, input.uploadId, ctx.userId),
          input.uploadId,
        );
        if (upload.state === "initiated" || upload.state === "uploading") {
          requireActiveUpload(upload);
        }
        const parts =
          upload.state === "uploading" && upload.r2MultipartUploadId
            ? await storageFor(dependencies).listParts(upload.objectKey, upload.r2MultipartUploadId)
            : [];
        fileUploadLifecycleTotal.add(1, { state: "resumed", import_type: upload.importType });
        return { upload: serializeUpload(upload), parts };
      }),

    complete: protectedProcedure
      .input(
        uploadIdInputSchema.extend({ parts: z.array(completedPartSchema).max(MAX_PART_COUNT) }),
      )
      .output(serializedUploadSchema)
      .mutation(async ({ ctx, input }) => {
        const remoteSideEffect: {
          completedObject: { objectKey: string; uploadId: string } | null;
        } = { completedObject: null };
        try {
          return await dependencies.withUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
            let upload = requireUpload(
              await dependencies.repository.find(transaction, input.uploadId, ctx.userId),
              input.uploadId,
            );
            if (
              ["queued", "processing", "completed"].includes(upload.state) &&
              upload.importJobId
            ) {
              return serializeUpload(upload);
            }
            requireActiveUpload(upload);
            if (!(await dependencies.repository.rateAllowed(transaction, ctx.userId, "complete"))) {
              throw new TRPCError({
                code: "TOO_MANY_REQUESTS",
                message: "Too many uploads completed; try again shortly",
              });
            }
            if (upload.state !== "uploading" || !upload.r2MultipartUploadId) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "Upload is not ready to complete",
              });
            }
            const authoritativeParts = await storageFor(dependencies).listParts(
              upload.objectKey,
              upload.r2MultipartUploadId,
            );
            const verifiedParts = verifyParts(upload, authoritativeParts, input.parts);
            upload = await translateExpiredUploadError(() =>
              dependencies.repository.recordCompletionParts(
                transaction,
                upload.id,
                ctx.userId,
                verifiedParts,
              ),
            );
            let object: { sizeBytes: number };
            try {
              await storageFor(dependencies).completeMultipartUpload(
                upload.objectKey,
                upload.r2MultipartUploadId ?? "",
                verifiedParts,
              );
              remoteSideEffect.completedObject = {
                objectKey: upload.objectKey,
                uploadId: upload.id,
              };
              object = await storageFor(dependencies).headObject(upload.objectKey);
            } catch (completionError) {
              try {
                object = await storageFor(dependencies).headObject(upload.objectKey);
                remoteSideEffect.completedObject = {
                  objectKey: upload.objectKey,
                  uploadId: upload.id,
                };
              } catch {
                throw completionError;
              }
            }
            upload = await translateExpiredUploadError(() =>
              dependencies.repository.markUploaded(transaction, upload.id, ctx.userId),
            );
            upload = await translateExpiredUploadError(() =>
              dependencies.repository.queue(transaction, upload.id, ctx.userId, {
                importJobId: `file-import-${upload.id}`,
                objectSizeBytes: object.sizeBytes,
              }),
            );
            fileUploadLifecycleTotal.add(1, {
              state: "queued",
              import_type: upload.importType,
            });
            fileUploadBytesTotal.add(object.sizeBytes, {
              import_type: upload.importType,
            });
            fileUploadCompletionDuration.record((Date.now() - upload.createdAt.getTime()) / 1_000, {
              import_type: upload.importType,
            });
            return serializeUpload(upload);
          });
        } catch (error: unknown) {
          if (remoteSideEffect.completedObject) {
            const completedObject = remoteSideEffect.completedObject;
            captureException(error, {
              tags: {
                source: "file-upload-complete",
                operation: "persistCompletedObject",
              },
              extra: completedObject,
            });
            try {
              await storageFor(dependencies).deleteObject(completedObject.objectKey);
            } catch (cleanupError: unknown) {
              captureException(cleanupError, {
                tags: {
                  source: "file-upload-complete",
                  operation: "deleteCompletedObject",
                },
                extra: completedObject,
              });
            }
          }
          throw error;
        }
      }),

    abort: protectedProcedure
      .input(uploadIdInputSchema)
      .output(serializedUploadSchema)
      .mutation(async ({ ctx, input }) => {
        const upload = requireUpload(
          await dependencies.repository.find(ctx.db, input.uploadId, ctx.userId),
          input.uploadId,
        );
        if (upload.state === "aborted") return serializeUpload(upload);
        if (upload.r2MultipartUploadId && upload.state === "uploading") {
          await storageFor(dependencies).abortMultipartUpload(
            upload.objectKey,
            upload.r2MultipartUploadId,
          );
        }
        const aborted = await dependencies.repository.abort(ctx.db, upload.id, ctx.userId);
        fileUploadLifecycleTotal.add(1, { state: "cancelled", import_type: aborted.importType });
        return serializeUpload(aborted);
      }),
  });
}

export const fileUploadRouter = createFileUploadRouter({
  repository: defaultRepository,
  withUserWriteFence: withAccountErasureUserWriteFence,
});
