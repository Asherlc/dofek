import { Sha256 } from "@aws-crypto/sha256-browser";
import { z } from "zod";

const HASH_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const MAX_PART_ATTEMPTS = 5;

export type FileUploadPhase =
  | "preparing"
  | "uploading"
  | "verifying"
  | "queueing"
  | "processing"
  | "completed"
  | "cancelled"
  | "failed";

export interface FileUploadProgress {
  phase: FileUploadPhase;
  percentage: number;
  message: string;
}

export interface StoredUploadSession {
  providerId: string;
  uploadId: string;
  importType: UploadImportType;
  filename: string;
  sizeBytes: number;
  lastModified: number;
  sha256: string;
  partSizeBytes: number;
  completedParts: Array<{ partNumber: number; etag: string }>;
  weightUnit?: "kg" | "lbs";
}

const uploadImportTypeSchema = z.enum([
  "apple-health",
  "strong-csv",
  "cronometer-csv",
  "kaya-export",
  "zos-app",
  "garmin-dump",
  "fit-file",
]);

const storedUploadSessionSchema = z.object({
  providerId: z.string().min(1),
  uploadId: z.uuid(),
  importType: uploadImportTypeSchema,
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  lastModified: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  partSizeBytes: z.number().int().positive(),
  completedParts: z.array(
    z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }),
  ),
  weightUnit: z.enum(["kg", "lbs"]).optional(),
});

export type UploadImportType = z.infer<typeof uploadImportTypeSchema>;

export interface UploadSessionStore {
  delete(providerId: string): Promise<void>;
  get(providerId: string): Promise<StoredUploadSession | null>;
  put(session: StoredUploadSession): Promise<void>;
}

interface UploadSummary {
  uploadId: string;
  state: string;
  partSizeBytes: number;
  importJobId: string | null;
  progressPercent: number;
  errorMessage: string | null;
}

export interface FileUploadApi {
  abort(input: { uploadId: string }): Promise<unknown>;
  authorizeParts(input: {
    uploadId: string;
    partNumbers: number[];
  }): Promise<{ parts: Array<{ partNumber: number; url: string; expiresAt: string }> }>;
  complete(input: {
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<UploadSummary>;
  initiate(input: {
    uploadId: string;
    importType: UploadImportType;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    fullSync?: boolean;
    weightUnit?: "kg" | "lbs";
  }): Promise<UploadSummary>;
  resume(input: { uploadId: string }): Promise<{
    upload: UploadSummary;
    parts: Array<{ partNumber: number; etag: string; sizeBytes: number }>;
  }>;
}

interface RunUploadOptions {
  api: FileUploadApi;
  file: File;
  importType: UploadImportType;
  providerId: string;
  sessionStore: UploadSessionStore;
  signal: AbortSignal;
  onProgress(progress: FileUploadProgress): void;
  onUploadInitiated?(uploadId: string): void;
  fullSync?: boolean;
  weightUnit?: "kg" | "lbs";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashFile(
  file: File,
  onProgress?: (percentage: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const sha256 = new Sha256();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_SIZE_BYTES) {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const chunk = file.slice(offset, Math.min(offset + HASH_CHUNK_SIZE_BYTES, file.size));
    sha256.update(new Uint8Array(await chunk.arrayBuffer()));
    onProgress?.(Math.round((Math.min(offset + chunk.size, file.size) / file.size) * 100));
  }
  return bytesToHex(await sha256.digest());
}

function sessionMatchesFile(
  session: StoredUploadSession,
  file: File,
  sha256: string,
  weightUnit: "kg" | "lbs" | undefined,
): boolean {
  return (
    session.filename === file.name &&
    session.sizeBytes === file.size &&
    session.lastModified === file.lastModified &&
    session.sha256 === sha256 &&
    session.weightUnit === weightUnit
  );
}

function uploadCancelledError(): DOMException {
  return new DOMException("Upload cancelled", "AbortError");
}

function throwIfUploadCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw uploadCancelledError();
}

async function cleanUpCancelledUpload(
  options: RunUploadOptions,
  uploadId: string | null,
  initiationMayHaveReachedServer: boolean,
): Promise<void> {
  const deleteSession = options.sessionStore.delete(options.providerId);
  if (!initiationMayHaveReachedServer || !uploadId) {
    await deleteSession;
    return;
  }
  const [abortResult, deleteResult] = await Promise.allSettled([
    options.api.abort({ uploadId }),
    deleteSession,
  ]);
  if (deleteResult.status === "rejected") throw deleteResult.reason;
  if (abortResult.status === "rejected" && !isUploadNotFoundError(abortResult.reason)) {
    throw abortResult.reason;
  }
}

function isUploadNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("data" in error)) return false;
  const data = error.data;
  return typeof data === "object" && data !== null && "code" in data && data.code === "NOT_FOUND";
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function uploadPartWithRetry(
  api: FileUploadApi,
  session: StoredUploadSession,
  file: File,
  partNumber: number,
  signal: AbortSignal,
): Promise<{ partNumber: number; etag: string }> {
  const start = (partNumber - 1) * session.partSizeBytes;
  const body = file.slice(start, Math.min(start + session.partSizeBytes, file.size));
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
    try {
      const authorization = await api.authorizeParts({
        uploadId: session.uploadId,
        partNumbers: [partNumber],
      });
      const authorizedPart = authorization.parts[0];
      if (!authorizedPart) throw new Error(`Part ${partNumber} authorization was not returned`);
      const response = await fetch(authorizedPart.url, { method: "PUT", body, signal });
      if (!response.ok)
        throw new Error(`Part ${partNumber} upload failed (HTTP ${response.status})`);
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`Part ${partNumber} upload did not return an ETag`);
      return { partNumber, etag };
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt === MAX_PART_ATTEMPTS - 1) break;
      const maximumDelayMs = Math.min(30_000, 500 * 2 ** attempt);
      await sleep(Math.random() * maximumDelayMs, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Part ${partNumber} upload failed`);
}

export async function runResumableFileUpload(options: RunUploadOptions): Promise<UploadSummary> {
  let uploadId: string | null = null;
  let initiationMayHaveReachedServer = false;
  let completionCommitted = false;
  try {
    options.onProgress({ phase: "preparing", percentage: 0, message: "Preparing upload..." });
    throwIfUploadCancelled(options.signal);
    const sha256 = await hashFile(
      options.file,
      (percentage) =>
        options.onProgress({
          phase: "preparing",
          percentage: Math.round(percentage * 0.1),
          message: "Verifying file integrity...",
        }),
      options.signal,
    );
    throwIfUploadCancelled(options.signal);
    const storedSession = await options.sessionStore.get(options.providerId);
    throwIfUploadCancelled(options.signal);
    const effectiveWeightUnit =
      options.weightUnit ??
      (options.importType === "strong-csv" ? storedSession?.weightUnit : undefined);
    uploadId =
      storedSession && sessionMatchesFile(storedSession, options.file, sha256, effectiveWeightUnit)
        ? storedSession.uploadId
        : crypto.randomUUID();
    initiationMayHaveReachedServer = true;
    const initiatedUpload = await options.api.initiate({
      uploadId,
      importType: options.importType,
      filename: options.file.name,
      contentType: options.file.type || "application/octet-stream",
      sizeBytes: options.file.size,
      sha256,
      fullSync: options.fullSync,
      weightUnit: effectiveWeightUnit,
    });
    throwIfUploadCancelled(options.signal);
    options.onUploadInitiated?.(uploadId);
    const resumed = await options.api.resume({ uploadId });
    throwIfUploadCancelled(options.signal);
    const completedParts = new Map(
      resumed.parts.map((part) => [
        part.partNumber,
        { partNumber: part.partNumber, etag: part.etag },
      ]),
    );
    const session: StoredUploadSession = {
      providerId: options.providerId,
      uploadId,
      importType: options.importType,
      filename: options.file.name,
      sizeBytes: options.file.size,
      lastModified: options.file.lastModified,
      sha256,
      partSizeBytes: initiatedUpload.partSizeBytes,
      completedParts: [...completedParts.values()],
      weightUnit: effectiveWeightUnit,
    };
    await options.sessionStore.put(session);
    throwIfUploadCancelled(options.signal);

    const partCount = Math.ceil(options.file.size / session.partSizeBytes);
    const pendingPartNumbers = Array.from({ length: partCount }, (_, index) => index + 1).filter(
      (partNumber) => !completedParts.has(partNumber),
    );
    let nextPartIndex = 0;
    const uploadWorker = async (): Promise<void> => {
      while (nextPartIndex < pendingPartNumbers.length) {
        const partNumber = pendingPartNumbers[nextPartIndex];
        nextPartIndex++;
        if (partNumber === undefined) return;
        const completedPart = await uploadPartWithRetry(
          options.api,
          session,
          options.file,
          partNumber,
          options.signal,
        );
        completedParts.set(partNumber, completedPart);
        session.completedParts = [...completedParts.values()].sort(
          (first, second) => first.partNumber - second.partNumber,
        );
        await options.sessionStore.put(session);
        throwIfUploadCancelled(options.signal);
        options.onProgress({
          phase: "uploading",
          percentage: 10 + Math.round((completedParts.size / partCount) * 75),
          message: `Uploaded ${completedParts.size} of ${partCount} parts`,
        });
      }
    };
    const uploadWorkers = Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, pendingPartNumbers.length) },
      () => uploadWorker(),
    );
    try {
      await Promise.all(uploadWorkers);
    } catch (error) {
      if (options.signal.aborted) await Promise.allSettled(uploadWorkers);
      throw error;
    }
    throwIfUploadCancelled(options.signal);

    options.onProgress({ phase: "verifying", percentage: 90, message: "Verifying upload..." });
    options.onProgress({ phase: "queueing", percentage: 95, message: "Queueing import..." });
    const completed = await options.api.complete({
      uploadId,
      parts: [...completedParts.values()].sort(
        (first, second) => first.partNumber - second.partNumber,
      ),
    });
    completionCommitted = true;
    await options.sessionStore.delete(options.providerId);
    return completed;
  } catch (error) {
    if (!options.signal.aborted || completionCommitted) throw error;
    await cleanUpCancelledUpload(options, uploadId, initiationMayHaveReachedServer);
    throw uploadCancelledError();
  }
}

const DATABASE_NAME = "dofek-file-uploads";
const STORE_NAME = "sessions";

function openUploadDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open upload storage"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Upload storage request failed"));
  });
}

export function deleteIndexedDbUploadDatabase(): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to delete upload storage"));
    request.onblocked = () =>
      reject(new Error("Upload storage deletion is blocked by another open Dofek tab"));
  });
}

export const indexedDbUploadSessionStore: UploadSessionStore = {
  async get(providerId) {
    const database = await openUploadDatabase();
    try {
      const value = await requestResult(
        database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(providerId),
      );
      return value === undefined ? null : storedUploadSessionSchema.parse(value);
    } finally {
      database.close();
    }
  },
  async put(session) {
    const database = await openUploadDatabase();
    try {
      await requestResult(
        database
          .transaction(STORE_NAME, "readwrite")
          .objectStore(STORE_NAME)
          .put(session, session.providerId),
      );
    } finally {
      database.close();
    }
  },
  async delete(providerId) {
    const database = await openUploadDatabase();
    try {
      await requestResult(
        database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(providerId),
      );
    } finally {
      database.close();
    }
  },
};
