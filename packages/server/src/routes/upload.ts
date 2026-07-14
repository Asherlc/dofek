import { mkdirSync } from "node:fs";
import { mkdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import type { Database } from "dofek/db";
import type { ImportJobData } from "dofek/jobs/queues";
import { type Request, type Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { assembleChunks, streamToFile } from "../lib/server-utils.ts";
import { startWorker } from "../lib/start-worker.ts";
import {
  getUploadStateStore,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_STATUS_TTL_MS,
  type UploadStatus,
} from "../lib/upload-state-store.ts";
import { logger } from "../logger.ts";

/**
 * Shared directory for uploaded files that the worker container can access.
 * In production, both web and worker containers mount the `job_files` volume
 * at /app/job-files. Falls back to OS temp dir for local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");
mkdirSync(JOB_FILES_DIR, { recursive: true });
const IN_PROGRESS_UPLOAD_STATUS_TTL_MS = UPLOAD_SESSION_TTL_MS + UPLOAD_STATUS_TTL_MS;
const GARMIN_DUMP_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const uploadStateStore = getUploadStateStore();

const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many upload requests; please try again later",
});

const uploadStatusRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1_800,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many upload status requests; please try again later",
});

async function setUploadStatus(
  uploadId: string,
  status: UploadStatus,
  timeToLiveMs = UPLOAD_STATUS_TTL_MS,
): Promise<void> {
  await uploadStateStore.saveUploadStatus(uploadId, status, timeToLiveMs);
}

function stripExpiry(status: UploadStatus): Omit<UploadStatus, "expiresAt"> {
  return {
    status: status.status,
    progress: status.progress,
    message: status.message,
    userId: status.userId,
  };
}

function inProgressStatus(
  status: "uploading" | "assembling",
  progress: number,
  message: string,
  userId: string,
): UploadStatus {
  return {
    status,
    progress,
    message,
    userId,
    expiresAt: Date.now() + UPLOAD_SESSION_TTL_MS,
  };
}

function exceedsContentLengthLimit(req: Request, maxBytes: number): boolean {
  const parsedContentLength = Number.parseInt(req.get("content-length") ?? "", 10);
  return Number.isFinite(parsedContentLength) && parsedContentLength > maxBytes;
}

async function expireStaleUpload(uploadId: string, userId: string): Promise<UploadStatus> {
  const staleUpload = await uploadStateStore.getUploadSession(uploadId);
  await uploadStateStore.deleteUploadSession(uploadId);
  if (staleUpload) {
    await rm(staleUpload.dir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn("Failed to clean up stale upload dir %s: %s", staleUpload.dir, error);
    });
  }
  const timeoutStatus: UploadStatus = {
    status: "error",
    progress: 0,
    message: "Upload timed out",
    userId,
  };
  await setUploadStatus(uploadId, timeoutStatus);
  return timeoutStatus;
}

async function enqueueImport(
  importQueue: Queue<ImportJobData>,
  filePath: string,
  since: Date,
  importType: ImportJobData["importType"],
  userId: string,
  opts?: { weightUnit?: "kg" | "lbs"; jobId?: string },
): Promise<string> {
  const job = await importQueue.add(
    importType,
    {
      filePath,
      since: since.toISOString(),
      userId,
      importType,
      weightUnit: opts?.weightUnit,
    },
    opts?.jobId ? { jobId: opts.jobId } : undefined,
  );
  startWorker();
  return job.id ?? `job-${Date.now()}`;
}

async function cleanupTempFile(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: unknown) => {
    logger.warn("Failed to clean up tmp file %s: %s", filePath, error);
  });
}

async function getImportJobStatus(importQueue: Queue<ImportJobData>, jobId: string) {
  let job: Awaited<ReturnType<Queue<ImportJobData>["getJob"]>> | undefined;
  try {
    job = await importQueue.getJob(jobId);
  } catch {
    return null; // Redis unavailable
  }
  if (!job) return null;

  const state = await job.getState();
  const progress: unknown = job.progress;
  const percentage =
    typeof progress === "number"
      ? progress
      : typeof progress === "object" &&
          progress !== null &&
          "percentage" in progress &&
          typeof progress.percentage === "number"
        ? progress.percentage
        : undefined;
  const msg =
    typeof progress === "object" && progress !== null && "message" in progress
      ? String(progress.message)
      : undefined;

  let status: "uploading" | "assembling" | "processing" | "done" | "error";
  if (state === "completed") status = "done";
  else if (state === "failed") status = "error";
  else status = "processing";

  const jobUserId =
    typeof job.data === "object" && job.data !== null && "userId" in job.data
      ? String(job.data.userId)
      : undefined;

  return {
    status,
    progress: status === "done" ? 100 : (percentage ?? 0),
    message: state === "failed" ? job.failedReason : msg,
    result: job.returnvalue,
    userId: jobUserId,
  };
}

interface UploadRouteDeps {
  importQueue: Queue<ImportJobData>;
  db: Database;
}

/** Validate session from cookie or Bearer header. Returns userId or null (sends 401). */
async function authenticate(req: Request, res: Response, db: Database): Promise<string | null> {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const session = await validateSession(db, sessionId);
  if (!session) {
    res.status(401).json({ error: "Session expired" });
    return null;
  }
  return session.userId;
}

interface FileImportRouteConfig {
  routeId: string;
  importType: ImportJobData["importType"];
  fileNamePrefix: string;
  defaultFileExtension: string;
  allowedFileExtensions: readonly string[];
  allowedContentTypes: readonly string[];
  unsupportedContentTypeMessage: string;
  invalidFileExtensionMessage?: string;
  maxUploadBytes?: number;
  rateLimited?: boolean;
  getSince: (request: Request) => Date;
  getJobOptions?: (request: Request) => { weightUnit?: "kg" | "lbs" };
  inferFileExtension?: (input: { contentType: string | undefined }) => string | undefined;
}

const csvContentTypes = ["text/csv", "application/octet-stream", "text/plain"] as const;

const uploadRouteConfigs: FileImportRouteConfig[] = [
  {
    routeId: "apple-health",
    importType: "apple-health",
    fileNamePrefix: "apple-health",
    defaultFileExtension: ".zip",
    allowedFileExtensions: [".zip", ".xml"],
    allowedContentTypes: [
      "application/octet-stream",
      "application/zip",
      "application/xml",
      "text/xml",
    ],
    unsupportedContentTypeMessage:
      "Unsupported Content-Type. Expected application/octet-stream, application/zip, application/xml, or text/xml",
    getSince: (request) =>
      request.query.fullSync === "true"
        ? new Date(0)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    inferFileExtension: ({ contentType }) =>
      contentType?.includes("xml") === true ? ".xml" : undefined,
  },
  {
    routeId: "strong-csv",
    importType: "strong-csv",
    fileNamePrefix: "strong-csv",
    defaultFileExtension: ".csv",
    allowedFileExtensions: [".csv"],
    allowedContentTypes: csvContentTypes,
    unsupportedContentTypeMessage:
      "Unsupported Content-Type. Expected text/csv, application/octet-stream, or text/plain",
    getSince: () => new Date(0),
    getJobOptions: (request) => ({ weightUnit: request.query.units === "lbs" ? "lbs" : "kg" }),
  },
  {
    routeId: "cronometer-csv",
    importType: "cronometer-csv",
    fileNamePrefix: "cronometer-csv",
    defaultFileExtension: ".csv",
    allowedFileExtensions: [".csv"],
    allowedContentTypes: csvContentTypes,
    unsupportedContentTypeMessage:
      "Unsupported Content-Type. Expected text/csv, application/octet-stream, or text/plain",
    getSince: () => new Date(0),
  },
  {
    routeId: "kaya-export",
    importType: "kaya-export",
    fileNamePrefix: "kaya-export",
    defaultFileExtension: ".csv",
    allowedFileExtensions: [".csv"],
    allowedContentTypes: csvContentTypes,
    unsupportedContentTypeMessage: "Kaya imports require a CSV export",
    invalidFileExtensionMessage: "Kaya imports require a CSV export",
    rateLimited: true,
    getSince: () => new Date(0),
  },
  {
    routeId: "zos-app",
    importType: "zos-app",
    fileNamePrefix: "zos-app",
    defaultFileExtension: ".bin",
    allowedFileExtensions: [".bin"],
    allowedContentTypes: ["application/octet-stream"],
    unsupportedContentTypeMessage: "Unsupported Content-Type. Expected application/octet-stream",
    getSince: () => new Date(0),
  },
  {
    routeId: "garmin-dump",
    importType: "garmin-dump",
    fileNamePrefix: "garmin-dump",
    defaultFileExtension: ".zip",
    allowedFileExtensions: [".zip"],
    allowedContentTypes: [
      "application/zip",
      "application/x-zip-compressed",
      "application/octet-stream",
    ],
    unsupportedContentTypeMessage:
      "Unsupported Content-Type. Expected application/zip or application/octet-stream",
    maxUploadBytes: GARMIN_DUMP_MAX_UPLOAD_BYTES,
    rateLimited: true,
    getSince: () => new Date(0),
  },
];

function getHeaderValue(request: Request, headerName: string): string | undefined {
  const value = request.headers[headerName.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function getNormalizedContentType(request: Request): string | undefined {
  return getHeaderValue(request, "content-type")?.split(";")[0]?.trim().toLowerCase();
}

function getUploadId(request: Request): string | undefined {
  return getHeaderValue(request, "x-upload-id");
}

function getChunkNumber(request: Request, headerName: string): number {
  return Number.parseInt(getHeaderValue(request, headerName) ?? "", 10);
}

function getRequestedFileExtension(request: Request): string | undefined {
  const extension = getHeaderValue(request, "x-file-ext")?.trim().toLowerCase();
  return extension && extension.length > 0 ? extension : undefined;
}

function getFileExtension(
  request: Request,
  config: FileImportRouteConfig,
  contentType: string | undefined,
): string {
  return (
    getRequestedFileExtension(request) ??
    config.inferFileExtension?.({ contentType }) ??
    config.defaultFileExtension
  );
}

function validateUploadRequest(
  request: Request,
  response: Response,
  config: FileImportRouteConfig,
): { contentType: string | undefined; uploadId: string | undefined; fileExtension: string } | null {
  const contentType = getNormalizedContentType(request);
  if (contentType && !config.allowedContentTypes.includes(contentType)) {
    response.status(415).json({ error: config.unsupportedContentTypeMessage });
    return null;
  }

  if (config.maxUploadBytes && exceedsContentLengthLimit(request, config.maxUploadBytes)) {
    response.status(413).json({
      error: `Garmin dump upload exceeds maximum size of ${config.maxUploadBytes} bytes`,
    });
    return null;
  }

  const uploadId = getUploadId(request);
  if (uploadId && !/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
    response.status(400).json({ error: "Invalid upload ID" });
    return null;
  }

  const fileExtension = getFileExtension(request, config, contentType);
  if (!config.allowedFileExtensions.includes(fileExtension)) {
    response.status(400).json({
      error: config.invalidFileExtensionMessage ?? "Invalid file extension",
    });
    return null;
  }

  return { contentType, uploadId, fileExtension };
}

async function handleUploadStatus(
  request: Request<{ jobId: string }>,
  response: Response,
  deps: UploadRouteDeps,
): Promise<void> {
  const userId = await authenticate(request, response, deps.db);
  if (!userId) return;

  const uploadStatus = await uploadStateStore.getUploadStatus(request.params.jobId);
  if (uploadStatus) {
    if (uploadStatus.userId !== userId) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    if (uploadStatus.expiresAt && uploadStatus.expiresAt <= Date.now()) {
      response.json(stripExpiry(await expireStaleUpload(request.params.jobId, userId)));
      return;
    }
    response.json(stripExpiry(uploadStatus));
    return;
  }

  const status = await getImportJobStatus(deps.importQueue, request.params.jobId);
  if (!status) {
    response.status(404).json({ error: "Unknown job" });
    return;
  }
  if (status.userId && status.userId !== userId) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }
  response.json(status);
}

async function handleSingleFileUpload({
  request,
  response,
  userId,
  config,
  fileExtension,
  deps,
}: {
  request: Request;
  response: Response;
  userId: string;
  config: FileImportRouteConfig;
  fileExtension: string;
  deps: UploadRouteDeps;
}): Promise<void> {
  const tmpId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tmpFile = join(JOB_FILES_DIR, `${config.fileNamePrefix}-${tmpId}${fileExtension}`);

  try {
    if (config.maxUploadBytes) {
      await streamToFile(request, tmpFile, config.maxUploadBytes);
    } else {
      await streamToFile(request, tmpFile);
    }
    const jobId = await enqueueImport(
      deps.importQueue,
      tmpFile,
      config.getSince(request),
      config.importType,
      userId,
      config.getJobOptions?.(request),
    );
    response.json({ status: "processing", jobId });
  } catch (error: unknown) {
    logger.error(`[${config.routeId}] Upload failed: ${error}`);
    await cleanupTempFile(tmpFile);
    response.status(500).json({ error: "Upload failed" });
  }
}

async function handleChunkedFileUpload({
  request,
  response,
  userId,
  config,
  uploadId,
  fileExtension,
  chunkIndex,
  chunkTotal,
  deps,
}: {
  request: Request;
  response: Response;
  userId: string;
  config: FileImportRouteConfig;
  uploadId: string;
  fileExtension: string;
  chunkIndex: number;
  chunkTotal: number;
  deps: UploadRouteDeps;
}): Promise<void> {
  if (
    !Number.isInteger(chunkIndex) ||
    !Number.isInteger(chunkTotal) ||
    chunkIndex < 0 ||
    chunkTotal <= 1 ||
    chunkIndex >= chunkTotal
  ) {
    response.status(400).json({ error: "Invalid chunk headers" });
    return;
  }

  try {
    let upload = await uploadStateStore.getUploadSession(uploadId);
    if (!upload) {
      const dir = join(JOB_FILES_DIR, `${config.fileNamePrefix}-chunked-${uploadId}`);
      await mkdir(dir, { recursive: true });
      upload = { total: chunkTotal, dir, userId };
      await uploadStateStore.saveUploadSession(uploadId, upload, IN_PROGRESS_UPLOAD_STATUS_TTL_MS);
      await setUploadStatus(
        uploadId,
        inProgressStatus("uploading", 0, "Receiving chunks...", userId),
        IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
      );
    } else if (upload.userId !== userId) {
      response.status(403).json({ error: "Forbidden" });
      return;
    } else if (upload.total !== chunkTotal) {
      response.status(400).json({ error: "Chunk total does not match existing upload" });
      return;
    }

    const chunkPath = join(upload.dir, `chunk-${String(chunkIndex).padStart(6, "0")}`);
    if (config.maxUploadBytes) {
      await streamToFile(request, chunkPath, config.maxUploadBytes);
    } else {
      await streamToFile(request, chunkPath);
    }
    const receivedCount = await uploadStateStore.addReceivedChunk(
      uploadId,
      chunkIndex,
      IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
    );
    await uploadStateStore.saveUploadSession(uploadId, upload, IN_PROGRESS_UPLOAD_STATUS_TTL_MS);

    const uploadPercentage = Math.round((receivedCount / upload.total) * 100);
    logger.info(`[upload] ${config.routeId} chunk ${chunkIndex + 1}/${chunkTotal} for ${uploadId}`);

    if (receivedCount < upload.total) {
      await setUploadStatus(
        uploadId,
        inProgressStatus(
          "uploading",
          uploadPercentage,
          `Received ${receivedCount}/${upload.total} chunks`,
          userId,
        ),
        IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
      );
      response.json({
        status: "uploading",
        jobId: uploadId,
        received: receivedCount,
        total: upload.total,
      });
      return;
    }

    const chunkDir = upload.dir;
    const since = config.getSince(request);
    const jobOptions = config.getJobOptions?.(request);
    await uploadStateStore.deleteUploadSession(uploadId);
    await setUploadStatus(
      uploadId,
      inProgressStatus("assembling", 0, "Assembling file...", userId),
      IN_PROGRESS_UPLOAD_STATUS_TTL_MS,
    );
    response.json({ status: "assembling", jobId: uploadId });

    void (async () => {
      try {
        const assembledFile = join(
          JOB_FILES_DIR,
          `${config.fileNamePrefix}-${uploadId}${fileExtension}`,
        );
        await assembleChunks(chunkDir, assembledFile);
        await rm(chunkDir, { recursive: true, force: true });
        await enqueueImport(deps.importQueue, assembledFile, since, config.importType, userId, {
          ...jobOptions,
          jobId: uploadId,
        });
        await uploadStateStore.deleteUploadStatus(uploadId);
      } catch (error: unknown) {
        logger.error(`[upload] Assembly/enqueue failed for ${uploadId}: ${error}`);
        await rm(chunkDir, { recursive: true, force: true }).catch((rmError: unknown) => {
          logger.warn("Failed to clean up chunk dir %s: %s", chunkDir, rmError);
        });
        await setUploadStatus(uploadId, {
          status: "error",
          progress: 0,
          message: "Failed to assemble uploaded file",
          userId,
        });
      }
    })();
  } catch (error: unknown) {
    logger.error(`[upload] Chunked upload failed: ${error}`);
    const upload = await uploadStateStore.getUploadSession(uploadId);
    if (upload) {
      await uploadStateStore.deleteUploadSession(uploadId);
      await rm(upload.dir, { recursive: true, force: true }).catch((rmError: unknown) => {
        logger.warn("Failed to clean up upload dir %s: %s", upload.dir, rmError);
      });
    }
    await setUploadStatus(uploadId, {
      status: "error",
      progress: 0,
      message: "Upload failed",
      userId,
    });
    response.status(500).json({ error: "Upload failed" });
  }
}

function registerFileImportRoutes(
  router: Router,
  config: FileImportRouteConfig,
  deps: UploadRouteDeps,
): void {
  router.get<{ jobId: string }>(
    `/${config.routeId}/status/:jobId`,
    uploadStatusRateLimiter,
    async (request, response) => {
      await handleUploadStatus(request, response, deps);
    },
  );

  const uploadHandler = async (request: Request, response: Response) => {
    const userId = await authenticate(request, response, deps.db);
    if (!userId) return;

    const validation = validateUploadRequest(request, response, config);
    if (!validation) return;

    const chunkTotal = getChunkNumber(request, "x-chunk-total");
    if (validation.uploadId && chunkTotal > 1) {
      await handleChunkedFileUpload({
        request,
        response,
        userId,
        config,
        uploadId: validation.uploadId,
        fileExtension: validation.fileExtension,
        chunkIndex: getChunkNumber(request, "x-chunk-index"),
        chunkTotal,
        deps,
      });
      return;
    }

    await handleSingleFileUpload({
      request,
      response,
      userId,
      config,
      fileExtension: validation.fileExtension,
      deps,
    });
  };

  if (config.rateLimited) {
    router.post(`/${config.routeId}`, uploadRateLimiter, uploadHandler);
    return;
  }
  router.post(`/${config.routeId}`, uploadHandler);
}

export function createUploadRouter(deps: UploadRouteDeps): Router {
  const router = Router();
  for (const config of uploadRouteConfigs) {
    registerFileImportRoutes(router, config, deps);
  }
  return router;
}
