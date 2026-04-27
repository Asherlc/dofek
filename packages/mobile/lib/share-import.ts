import { z } from "zod";
import { captureException } from "./telemetry";

const importProviderIds = ["apple-health", "strong-csv", "cronometer-csv"] as const;

export type ImportProviderId = (typeof importProviderIds)[number];

export interface InferImportProviderInput {
  fileName: string;
  fileExtension: string;
  mimeType: string | null;
  csvHeaderLine: string;
}

export interface ShareImportProgress {
  status: "reading" | "uploading" | "processing" | "done" | "error";
  progress: number;
  message: string;
  providerId?: ImportProviderId;
}

export interface ImportSharedFileArgs {
  fileUri: string;
  serverUrl: string;
  sessionToken: string;
  onProgress?: (progress: ShareImportProgress) => void;
}

interface ImportSharedFileDeps {
  fetchImpl?: typeof fetch;
  readBlob?: (fileUri: string) => Promise<Blob>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface ShareImportResult {
  providerId: ImportProviderId;
  jobId: string;
}

interface SharedFileInfo {
  fileName: string;
  fileExtension: string;
}

interface UploadTarget {
  uploadUrl: string;
  statusUrl: string;
}

const uploadResponseSchema = z
  .object({
    status: z.string().optional(),
    jobId: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const statusResponseSchema = z
  .object({
    status: z.enum(["uploading", "assembling", "processing", "done", "error"]),
    progress: z.number().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

function normalizeExtension(fileExtension: string): string {
  const trimmed = fileExtension.trim().toLowerCase();
  if (trimmed === "") return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function getSharedFileInfo(fileUri: string): SharedFileInfo {
  const uriWithoutQuery = fileUri.split("?")[0] ?? fileUri;
  const encodedName = uriWithoutQuery.split("/").pop() ?? "shared-file";
  const fileName = decodeURIComponent(encodedName);
  const dotIndex = fileName.lastIndexOf(".");
  const fileExtension = dotIndex >= 0 ? normalizeExtension(fileName.slice(dotIndex)) : "";
  return { fileName, fileExtension };
}

function getUploadTarget(serverUrl: string, providerId: ImportProviderId): UploadTarget {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  switch (providerId) {
    case "apple-health":
      return {
        uploadUrl: `${baseUrl}/api/upload/apple-health?fullSync=true`,
        statusUrl: `${baseUrl}/api/upload/apple-health/status`,
      };
    case "strong-csv":
      return {
        uploadUrl: `${baseUrl}/api/upload/strong-csv?units=kg`,
        statusUrl: `${baseUrl}/api/upload/strong-csv/status`,
      };
    case "cronometer-csv":
      return {
        uploadUrl: `${baseUrl}/api/upload/cronometer-csv`,
        statusUrl: `${baseUrl}/api/upload/cronometer-csv/status`,
      };
  }
}

function matchesCsvHeader(csvHeaderLine: string, requiredColumns: string[]): boolean {
  const normalized = csvHeaderLine
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();
  if (normalized === "") return false;
  return requiredColumns.every((column) => normalized.includes(column));
}

function parseErrorMessage(data: unknown, fallback: string): string {
  const parsed = z
    .object({
      error: z.string().optional(),
      message: z.string().optional(),
    })
    .safeParse(data);
  if (!parsed.success) return fallback;
  return parsed.data.error ?? parsed.data.message ?? fallback;
}

function getContentTypeForUpload(providerId: ImportProviderId, fileExtension: string): string {
  if (providerId === "apple-health") {
    return fileExtension === ".xml" ? "application/xml" : "application/zip";
  }
  return "text/csv";
}

function isCsvLike(fileExtension: string, mimeType: string | null): boolean {
  if (fileExtension === ".csv") return true;
  const lowerMimeType = (mimeType ?? "").toLowerCase();
  return lowerMimeType.includes("csv") || lowerMimeType.includes("text/plain");
}

function isAppleHealthLike(fileExtension: string, mimeType: string | null): boolean {
  if (fileExtension === ".zip" || fileExtension === ".xml") return true;
  const lowerMimeType = (mimeType ?? "").toLowerCase();
  return lowerMimeType.includes("zip") || lowerMimeType.includes("xml");
}

export function inferImportProviderFromFile({
  fileName,
  fileExtension,
  mimeType,
  csvHeaderLine,
}: InferImportProviderInput): ImportProviderId | null {
  const normalizedExtension = normalizeExtension(fileExtension);
  const normalizedFileName = fileName.trim().toLowerCase();

  if (isAppleHealthLike(normalizedExtension, mimeType)) {
    return "apple-health";
  }

  if (!isCsvLike(normalizedExtension, mimeType)) {
    return null;
  }

  if (matchesCsvHeader(csvHeaderLine, ["date", "workout name", "duration", "exercise name"])) {
    return "strong-csv";
  }

  if (matchesCsvHeader(csvHeaderLine, ["day", "meal", "food name"])) {
    return "cronometer-csv";
  }

  if (normalizedFileName.includes("cronometer")) return "cronometer-csv";
  if (normalizedFileName.includes("strong")) return "strong-csv";

  return null;
}

function getCsvHeaderLine(csvText: string): string {
  return (
    csvText
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)[0]
      ?.trim() ?? ""
  );
}

function hasBlobTextReader(blob: Blob): boolean {
  return typeof Reflect.get(blob, "text") === "function";
}

async function readBlobText(blob: Blob, fileUri: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    if (hasBlobTextReader(blob)) {
      return await blob.text();
    }
  } catch {
    // Ignore error and fall through
  }

  try {
    const arrayBuffer = await blob.arrayBuffer();
    return new TextDecoder().decode(arrayBuffer);
  } catch {
    // Ignore error and fall through
  }

  // Fallback to fetching the file URI directly
  const response = await fetchImpl(fileUri);
  if (!response.ok) {
    throw new Error(`Failed to read shared file via fetch fallback (${response.status})`);
  }
  return response.text();
}

async function readBlob(fetchImpl: typeof fetch, fileUri: string): Promise<Blob> {
  const response = await fetchImpl(fileUri);
  if (!response.ok) {
    throw new Error(`Failed to read shared file (${response.status})`);
  }
  return response.blob();
}

async function parseUploadResponse(response: Response): Promise<{ jobId: string }> {
  const json: unknown = await response.json().catch((error: unknown) => {
    captureException(error, {
      source: "share-import-upload-response-json-parse",
      url: response.url,
      status: response.status,
    });
    return {};
  });
  const parsed = uploadResponseSchema.safeParse(json);
  if (!response.ok) {
    throw new Error(parseErrorMessage(json, `Upload failed (HTTP ${response.status})`));
  }
  if (!parsed.success || !parsed.data.jobId) {
    throw new Error("Upload did not return a job ID");
  }
  return { jobId: parsed.data.jobId };
}

async function uploadAppleHealthFile(
  fetchImpl: typeof fetch,
  target: UploadTarget,
  blob: Blob,
  fileExtension: string,
  sessionToken: string,
  onProgress?: (progress: ShareImportProgress) => void,
  now?: () => number,
): Promise<string> {
  const chunkSize = 50 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(blob.size / chunkSize));
  const uploadId = `share-${(now ?? Date.now)()}-${Math.random().toString(36).slice(2, 8)}`;
  let jobId: string | null = null;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, blob.size);
    const chunk = blob.slice(start, end);
    onProgress?.({
      status: "uploading",
      progress: Math.round(((chunkIndex + 1) / totalChunks) * 50),
      message:
        totalChunks > 1
          ? `Uploading chunk ${chunkIndex + 1} of ${totalChunks}...`
          : "Uploading file...",
      providerId: "apple-health",
    });

    const response = await fetchImpl(target.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/octet-stream",
        "x-upload-id": uploadId,
        "x-chunk-index": String(chunkIndex),
        "x-chunk-total": String(totalChunks),
        "x-file-ext": fileExtension === ".xml" ? ".xml" : ".zip",
      },
      body: chunk,
    });

    const result = await parseUploadResponse(response);
    jobId = result.jobId;
  }

  if (!jobId) {
    throw new Error("Upload did not return a job ID");
  }
  return jobId;
}

async function uploadSingleFile(
  fetchImpl: typeof fetch,
  target: UploadTarget,
  blob: Blob,
  providerId: ImportProviderId,
  fileExtension: string,
  sessionToken: string,
  onProgress?: (progress: ShareImportProgress) => void,
): Promise<string> {
  onProgress?.({
    status: "uploading",
    progress: 25,
    message: "Uploading file...",
    providerId,
  });

  const response = await fetchImpl(target.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": getContentTypeForUpload(providerId, fileExtension),
    },
    body: blob,
  });

  const result = await parseUploadResponse(response);
  return result.jobId;
}

async function pollImportStatus(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  statusUrl: string,
  jobId: string,
  sessionToken: string,
  providerId: ImportProviderId,
  onProgress?: (progress: ShareImportProgress) => void,
): Promise<void> {
  const maxAttempts = 600;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchImpl(`${statusUrl}/${jobId}`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });
    const json: unknown = await response.json().catch((error: unknown) => {
      captureException(error, {
        source: "share-import-status-response-json-parse",
        url: response.url,
        status: response.status,
      });
      return {};
    });
    if (!response.ok) {
      throw new Error(parseErrorMessage(json, `Status check failed (HTTP ${response.status})`));
    }

    const parsed = statusResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("Invalid status response from server");
    }

    const status = parsed.data.status;
    const progress = parsed.data.progress ?? 0;
    const message = parsed.data.message ?? "Processing import...";

    if (status === "done") {
      onProgress?.({
        status: "done",
        progress: 100,
        message: "Import complete.",
        providerId,
      });
      return;
    }

    if (status === "error") {
      throw new Error(parsed.data.message ?? parsed.data.error ?? "Import failed");
    }

    onProgress?.({
      status: "processing",
      progress: Math.max(50, progress),
      message,
      providerId,
    });

    await sleep(1000);
  }

  throw new Error("Import timed out");
}

export async function importSharedFile(
  args: ImportSharedFileArgs,
  deps: ImportSharedFileDeps = {},
): Promise<ShareImportResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep =
    deps.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));

  const { fileName, fileExtension } = getSharedFileInfo(args.fileUri);
  args.onProgress?.({
    status: "reading",
    progress: 0,
    message: `Preparing ${fileName}...`,
  });

  try {
    const readBlobFn = deps.readBlob ?? ((uri: string) => readBlob(fetchImpl, uri));
    const blob = await readBlobFn(args.fileUri);
    const mimeType = blob.type || null;

    const csvHeaderLine =
      fileExtension === ".csv"
        ? getCsvHeaderLine(await readBlobText(blob, args.fileUri, fetchImpl))
        : "";

    const providerId = inferImportProviderFromFile({
      fileName,
      fileExtension,
      mimeType,
      csvHeaderLine,
    });

    if (!providerId) {
      throw new Error("Unsupported shared file type");
    }

    const target = getUploadTarget(args.serverUrl, providerId);
    const jobId =
      providerId === "apple-health"
        ? await uploadAppleHealthFile(
            fetchImpl,
            target,
            blob,
            fileExtension,
            args.sessionToken,
            args.onProgress,
            deps.now,
          )
        : await uploadSingleFile(
            fetchImpl,
            target,
            blob,
            providerId,
            fileExtension,
            args.sessionToken,
            args.onProgress,
          );

    args.onProgress?.({
      status: "processing",
      progress: 50,
      message: "Processing import...",
      providerId,
    });

    await pollImportStatus(
      fetchImpl,
      sleep,
      target.statusUrl,
      jobId,
      args.sessionToken,
      providerId,
      args.onProgress,
    );

    return { providerId, jobId };
  } catch (error: unknown) {
    captureException(error, {
      source: "share-import-import-shared-file",
      fileUri: args.fileUri,
      serverUrl: args.serverUrl,
    });
    const message = error instanceof Error ? error.message : "Import failed";
    args.onProgress?.({
      status: "error",
      progress: 0,
      message,
    });
    throw error;
  }
}
