import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
const mockS3Client = vi.fn(() => ({ send: mockSend }));
const mockPutObjectCommand = vi.fn((input: unknown) => ({ command: "put", input }));
const mockGetObjectCommand = vi.fn((input: unknown) => ({ command: "get", input }));
const mockGetSignedUrl = vi.fn().mockResolvedValue("https://r2.example.test/signed");

vi.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: mockGetObjectCommand,
  PutObjectCommand: mockPutObjectCommand,
  S3Client: mockS3Client,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("node:fs", () => ({
  createReadStream: vi.fn(() => Readable.from(["zip-bytes"])),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(() => Promise.resolve({ size: 1234 })),
}));

const envBackup = { ...process.env };

async function loadStorageModule() {
  vi.resetModules();
  return import("./export-storage.ts");
}

function setR2Env() {
  process.env.R2_ENDPOINT = "https://account.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "access-key";
  process.env.R2_SECRET_ACCESS_KEY = "secret-key";
  process.env.EXPORT_R2_BUCKET = "dofek-exports";
}

describe("export storage", () => {
  beforeEach(() => {
    process.env = { ...envBackup };
    vi.clearAllMocks();
    mockGetSignedUrl.mockResolvedValue("https://r2.example.test/signed");
  });

  it("builds user-scoped export object keys", async () => {
    const { buildExportObjectKey } = await loadStorageModule();
    expect(buildExportObjectKey("user-1", "export-1")).toBe(
      "exports/user-1/export-1/dofek-export.zip",
    );
  });

  it("fails loudly when R2 configuration is missing", async () => {
    const { createSignedExportDownloadUrl } = await loadStorageModule();
    setR2Env();
    delete process.env.EXPORT_R2_BUCKET;

    await expect(
      createSignedExportDownloadUrl("exports/user/export/dofek-export.zip"),
    ).rejects.toThrow("EXPORT_R2_BUCKET");
  });

  it("uploads export ZIP files to R2 with a user-scoped key", async () => {
    setR2Env();
    const { uploadExportFileToR2 } = await loadStorageModule();

    await expect(
      uploadExportFileToR2("/tmp/dofek-export.zip", {
        exportId: "export-1",
        userId: "user-1",
      }),
    ).resolves.toEqual({
      objectKey: "exports/user-1/export-1/dofek-export.zip",
      sizeBytes: 1234,
    });

    expect(mockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
        endpoint: "https://account.r2.cloudflarestorage.com",
        region: "auto",
      }),
    );
    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "dofek-exports",
        Key: "exports/user-1/export-1/dofek-export.zip",
      }),
    );
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ command: "put" }));
  });

  it("creates signed download URLs for completed export objects", async () => {
    setR2Env();
    const { createSignedExportDownloadUrl } = await loadStorageModule();

    await expect(
      createSignedExportDownloadUrl("exports/user-1/export-1/dofek-export.zip"),
    ).resolves.toBe("https://r2.example.test/signed");

    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: "dofek-exports",
      Key: "exports/user-1/export-1/dofek-export.zip",
    });
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: "get" }),
      { expiresIn: 604_800 },
    );
  });
});
