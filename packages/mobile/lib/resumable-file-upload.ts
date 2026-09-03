export type UploadImportType =
  | "apple-health"
  | "strong-csv"
  | "cronometer-csv"
  | "kaya-export"
  | "garmin-dump"
  | "fit-file";

export interface FileUploadApi {
  initiate(input: {
    uploadId: string;
    importType: UploadImportType;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    weightUnit?: "kg" | "lbs";
  }): Promise<{ uploadId: string; partSizeBytes: number }>;
  authorizeParts(input: {
    uploadId: string;
    partNumbers: number[];
  }): Promise<{ parts: Array<{ partNumber: number; url: string; expiresAt: string }> }>;
  complete(input: {
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<{ uploadId: string; importJobId: string | null }>;
  resume(input: { uploadId: string }): Promise<{
    upload: {
      uploadId: string;
      state: string;
      progressPercent?: number;
      errorMessage?: string | null;
    };
    parts: Array<{ partNumber: number; etag: string; sizeBytes: number }>;
  }>;
}

export interface UploadableMobileFile {
  uri: string;
  name: string;
  type: string;
  size: number;
  sha256(): Promise<string>;
  uploadPart(input: {
    url: string;
    offset: number;
    length: number;
    onProgress(progress: { bytesSent: number; totalBytes: number }): void;
  }): Promise<{ status: number; headers: Record<string, string> }>;
}

export interface MobileUploadProgress {
  phase: "preparing" | "uploading" | "queueing";
  percentage: number;
  message: string;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

export async function runMobileResumableFileUpload({
  api,
  file,
  importType,
  weightUnit,
  onProgress,
  createUploadId,
}: {
  api: FileUploadApi;
  file: UploadableMobileFile;
  importType: UploadImportType;
  weightUnit?: "kg" | "lbs";
  onProgress(progress: MobileUploadProgress): void;
  createUploadId(): string;
}): Promise<{ uploadId: string; importJobId: string | null }> {
  onProgress({ phase: "preparing", percentage: 0, message: "Verifying file integrity..." });
  const uploadId = createUploadId();
  const initiated = await api.initiate({
    uploadId,
    importType,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    sha256: await file.sha256(),
    weightUnit: importType === "strong-csv" ? weightUnit : undefined,
  });
  const resumed = await api.resume({ uploadId: initiated.uploadId });
  const completedParts = new Map(
    resumed.parts.map((part) => [
      part.partNumber,
      { partNumber: part.partNumber, etag: part.etag },
    ]),
  );
  const partCount = Math.ceil(file.size / initiated.partSizeBytes);

  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    if (completedParts.has(partNumber)) continue;
    const authorization = await api.authorizeParts({
      uploadId: initiated.uploadId,
      partNumbers: [partNumber],
    });
    const part = authorization.parts[0];
    if (!part) throw new Error(`Part ${partNumber} authorization was not returned`);
    const offset = (partNumber - 1) * initiated.partSizeBytes;
    const length = Math.min(initiated.partSizeBytes, file.size - offset);
    onProgress({
      phase: "uploading",
      percentage: Math.round((completedParts.size / partCount) * 90),
      message: `Uploading part ${partNumber} of ${partCount}...`,
    });
    const result = await file.uploadPart({
      url: part.url,
      offset,
      length,
      onProgress: () => {},
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Part ${partNumber} upload failed (HTTP ${result.status})`);
    }
    const etag = header(result.headers, "etag");
    if (!etag) throw new Error(`Part ${partNumber} upload did not return an ETag`);
    completedParts.set(partNumber, { partNumber, etag });
  }

  onProgress({ phase: "queueing", percentage: 95, message: "Queueing import..." });
  return await api.complete({
    uploadId: initiated.uploadId,
    parts: [...completedParts.values()].sort(
      (first, second) => first.partNumber - second.partNumber,
    ),
  });
}
