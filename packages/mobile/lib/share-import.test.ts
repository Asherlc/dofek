import { describe, expect, it, vi } from "vitest";
import type { FileUploadApi, UploadableMobileFile } from "./resumable-file-upload";
import { importSharedFile, inferImportProviderFromFile } from "./share-import";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

describe("inferImportProviderFromFile", () => {
  it("detects Strong CSV by header", () => {
    expect(
      inferImportProviderFromFile({
        fileName: "export.csv",
        fileExtension: ".csv",
        mimeType: "text/csv",
        csvHeaderLine: "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps",
      }),
    ).toBe("strong-csv");
  });

  it("detects Garmin and FIT exports from their file names", () => {
    expect(
      inferImportProviderFromFile({
        fileName: "garmin-export.zip",
        fileExtension: ".zip",
        mimeType: "application/zip",
        csvHeaderLine: "",
      }),
    ).toBe("garmin-dump");
    expect(
      inferImportProviderFromFile({
        fileName: "morning-ride.fit",
        fileExtension: ".fit",
        mimeType: "application/octet-stream",
        csvHeaderLine: "",
      }),
    ).toBe("fit-file");
  });
});

describe("importSharedFile", () => {
  it("imports a shared Strong CSV through the durable upload lifecycle", async () => {
    const uploadId = "7b817a28-7c3b-470b-8e0b-d2b6f5fb3afc";
    const uploadPart = vi.fn(async () => ({ status: 200, headers: { etag: "part-etag" } }));
    const file: UploadableMobileFile & { text(): Promise<string> } = {
      uri: "file:///tmp/Strong%20Export.csv",
      name: "Strong Export.csv",
      type: "text/csv",
      size: 80,
      text: vi.fn(
        async () => "Date,Workout Name,Duration,Exercise Name\\n2026-03-10,Leg Day,00:45:00,Squat",
      ),
      sha256: vi.fn(async () => "a".repeat(64)),
      uploadPart,
    };
    const fileUploadApi: FileUploadApi = {
      initiate: vi.fn(async () => ({ uploadId, partSizeBytes: 16 * 1024 * 1024 })),
      authorizeParts: vi.fn(async () => ({
        parts: [
          {
            partNumber: 1,
            url: "https://r2.example/part-1",
            expiresAt: "2026-08-27T20:00:00.000Z",
          },
        ],
      })),
      complete: vi.fn(async () => ({ uploadId, importJobId: `file-import-${uploadId}` })),
      resume: vi
        .fn()
        .mockResolvedValueOnce({ upload: { uploadId, state: "uploading" }, parts: [] })
        .mockResolvedValueOnce({
          upload: { uploadId, state: "completed", progressPercent: 100, errorMessage: null },
          parts: [],
        }),
    };
    const statuses: string[] = [];

    const result = await importSharedFile(
      {
        fileUri: file.uri,
        onProgress: (progress) => statuses.push(progress.status),
      },
      { file, fileUploadApi, createUploadId: () => uploadId, sleep: async () => {} },
    );

    expect(fileUploadApi.initiate).toHaveBeenCalledWith(
      expect.objectContaining({ importType: "strong-csv", filename: "Strong Export.csv" }),
    );
    expect(uploadPart).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://r2.example/part-1" }),
    );
    expect(result).toEqual({ providerId: "strong-csv", jobId: `file-import-${uploadId}` });
    expect(statuses).toContain("done");
  });

  it("reports the server import error", async () => {
    const file: UploadableMobileFile & { text(): Promise<string> } = {
      uri: "file:///tmp/export.csv",
      name: "export.csv",
      type: "text/csv",
      size: 10,
      text: async () => "Date,Workout Name,Duration,Exercise Name",
      sha256: async () => "b".repeat(64),
      uploadPart: async () => ({ status: 200, headers: { etag: "part-etag" } }),
    };
    const uploadId = "dbdfe741-83e3-4a4f-9fdb-a65f9b7c4766";
    const api: FileUploadApi = {
      initiate: async () => ({ uploadId, partSizeBytes: 16 * 1024 * 1024 }),
      authorizeParts: async () => ({
        parts: [
          {
            partNumber: 1,
            url: "https://r2.example/part-1",
            expiresAt: "2026-08-27T20:00:00.000Z",
          },
        ],
      }),
      complete: async () => ({ uploadId, importJobId: `file-import-${uploadId}` }),
      resume: vi
        .fn()
        .mockResolvedValueOnce({ upload: { uploadId, state: "uploading" }, parts: [] })
        .mockResolvedValueOnce({
          upload: { uploadId, state: "failed", errorMessage: "Strong export is invalid" },
          parts: [],
        }),
    };

    await expect(
      importSharedFile(
        { fileUri: file.uri, providerId: "strong-csv" },
        { file, fileUploadApi: api, createUploadId: () => uploadId, sleep: async () => {} },
      ),
    ).rejects.toThrow("Strong export is invalid");
  });
});
