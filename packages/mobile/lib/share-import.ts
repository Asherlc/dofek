import {
  type FileUploadApi,
  runMobileResumableFileUpload,
  type UploadableMobileFile,
  type UploadImportType,
} from "./resumable-file-upload";
import { captureException } from "./telemetry";

export type ImportProviderId = UploadImportType;
export type StrongWeightUnit = "kg" | "lbs";

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
  providerId?: ImportProviderId;
  onProgress?: (progress: ShareImportProgress) => void;
  selectStrongWeightUnit?: () => Promise<StrongWeightUnit | null>;
}

export interface SharedImportFile extends UploadableMobileFile {
  text(): Promise<string>;
}

export interface ImportSharedFileDeps {
  createUploadId(): string;
  file: SharedImportFile;
  fileUploadApi: FileUploadApi;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ShareImportResult {
  providerId: ImportProviderId;
  jobId: string;
}

function normalizeExtension(fileExtension: string): string {
  const trimmed = fileExtension.trim().toLowerCase();
  if (trimmed === "") return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function extensionForFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? normalizeExtension(fileName.slice(dotIndex)) : "";
}

function matchesCsvHeader(csvHeaderLine: string, requiredColumns: string[]): boolean {
  const normalized = csvHeaderLine
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();
  if (normalized === "") return false;
  return requiredColumns.every((column) => normalized.includes(column));
}

function isCsvLike(fileExtension: string, mimeType: string | null): boolean {
  if (fileExtension === ".csv") return true;
  const lowerMimeType = (mimeType ?? "").toLowerCase();
  return (
    lowerMimeType.includes("csv") ||
    lowerMimeType.includes("text/plain") ||
    (fileExtension === "" && lowerMimeType.startsWith("application/octet-stream"))
  );
}

function isAppleHealthLike(fileExtension: string, mimeType: string | null): boolean {
  if (fileExtension === ".zip" || fileExtension === ".xml") return true;
  const lowerMimeType = (mimeType ?? "").toLowerCase();
  return lowerMimeType.includes("zip") || lowerMimeType.includes("xml");
}

function isGarminDumpLike(fileName: string, fileExtension: string): boolean {
  if (fileExtension !== ".zip") return false;
  return (
    fileName.includes("garmin") ||
    fileName.includes("di_connect") ||
    fileName.includes("di-connect")
  );
}

export function inferImportProviderFromFile({
  fileName,
  fileExtension,
  mimeType,
  csvHeaderLine,
}: InferImportProviderInput): ImportProviderId | null {
  const normalizedExtension = normalizeExtension(fileExtension);
  const normalizedFileName = fileName.trim().toLowerCase();

  if (isGarminDumpLike(normalizedFileName, normalizedExtension)) return "garmin-dump";
  if (normalizedExtension === ".fit") return "fit-file";
  if (isAppleHealthLike(normalizedExtension, mimeType)) return "apple-health";
  if (!isCsvLike(normalizedExtension, mimeType)) return null;
  if (matchesCsvHeader(csvHeaderLine, ["date", "workout name", "duration", "exercise name"])) {
    return "strong-csv";
  }
  if (matchesCsvHeader(csvHeaderLine, ["day", "meal", "food name"])) return "cronometer-csv";
  if (normalizedFileName.includes("cronometer")) return "cronometer-csv";
  if (normalizedFileName.includes("strong")) return "strong-csv";
  if (normalizedFileName.includes("kaya")) return "kaya-export";
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

function progressForUpload(
  progress: { phase: "preparing" | "uploading" | "queueing"; percentage: number; message: string },
  providerId: ImportProviderId,
): ShareImportProgress {
  return {
    status:
      progress.phase === "preparing"
        ? "reading"
        : progress.phase === "uploading"
          ? "uploading"
          : "processing",
    progress: progress.percentage,
    message: progress.message,
    providerId,
  };
}

export async function importSharedFile(
  args: ImportSharedFileArgs,
  deps: ImportSharedFileDeps,
): Promise<ShareImportResult | null> {
  try {
    const fileExtension = extensionForFileName(deps.file.name);
    const csvHeaderLine = isCsvLike(fileExtension, deps.file.type || null)
      ? getCsvHeaderLine(await deps.file.text())
      : "";
    const providerId =
      args.providerId ??
      inferImportProviderFromFile({
        fileName: deps.file.name,
        fileExtension,
        mimeType: deps.file.type || null,
        csvHeaderLine,
      });
    if (!providerId) throw new Error("Unsupported shared file type");
    let weightUnit: StrongWeightUnit | undefined;
    if (providerId === "strong-csv") {
      const selectedWeightUnit = await args.selectStrongWeightUnit?.();
      if (selectedWeightUnit === undefined) {
        throw new Error("Choose kg or lbs before importing a Strong export");
      }
      if (selectedWeightUnit === null) return null;
      weightUnit = selectedWeightUnit;
    }

    const completed = await runMobileResumableFileUpload({
      api: deps.fileUploadApi,
      file: deps.file,
      importType: providerId,
      weightUnit,
      createUploadId: deps.createUploadId,
      onProgress: (progress) => args.onProgress?.(progressForUpload(progress, providerId)),
    });
    if (!completed.importJobId)
      throw new Error("Upload completion did not return an import job ID");

    const sleep =
      deps.sleep ??
      ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    for (;;) {
      const { upload } = await deps.fileUploadApi.resume({ uploadId: completed.uploadId });
      if (upload.state === "completed") {
        args.onProgress?.({
          status: "done",
          progress: 100,
          message: "Import complete.",
          providerId,
        });
        return { providerId, jobId: completed.importJobId };
      }
      if (upload.state === "failed") {
        throw new Error(upload.errorMessage ?? "Import failed");
      }
      if (upload.state === "aborted" || upload.state === "expired") {
        throw new Error(upload.state === "expired" ? "Upload expired" : "Upload cancelled");
      }
      args.onProgress?.({
        status: "processing",
        progress: upload.progressPercent ?? 95,
        message: upload.state === "queued" ? "Import queued..." : "Processing import...",
        providerId,
      });
      await sleep(1000);
    }
  } catch (error: unknown) {
    captureException(error, { source: "share-import-import-shared-file", fileUri: args.fileUri });
    const message = error instanceof Error ? error.message : "Import failed";
    args.onProgress?.({ status: "error", progress: 0, message, providerId: args.providerId });
    throw error;
  }
}
