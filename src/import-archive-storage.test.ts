import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
const mockS3Client = vi.fn(() => ({ send: mockSend }));
const mockPutObjectCommand = vi.fn((input: unknown) => ({ command: "put", input }));

vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: mockPutObjectCommand,
  S3Client: mockS3Client,
}));

vi.mock("node:fs", () => ({
  createReadStream: vi.fn(() => Readable.from(["source-bytes"])),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(() => Promise.resolve({ size: 12 })),
}));

vi.mock("node:crypto", () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "source-sha256"),
  })),
}));

const environmentBackup = { ...process.env };

async function loadModule() {
  vi.resetModules();
  return import("./import-archive-storage.ts");
}

function setR2Environment() {
  process.env.R2_ENDPOINT = "https://account.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "access-key";
  process.env.R2_SECRET_ACCESS_KEY = "secret-key";
  process.env.IMPORT_R2_BUCKET = "dofek-import-archive";
}

describe("import archive storage", () => {
  beforeEach(() => {
    process.env = { ...environmentBackup };
    vi.clearAllMocks();
  });

  it("stores an immutable, provider-scoped artifact in R2", async () => {
    setR2Environment();
    const { archiveImportFileToR2 } = await loadModule();

    await expect(
      archiveImportFileToR2("/tmp/strong.csv", {
        contentType: "text/csv",
        extension: ".csv",
        importType: "strong-csv",
        userId: "user-1",
      }),
    ).resolves.toEqual({
      objectKey: "imports/v1/user-1/strong-csv/source-sha256.csv",
      sha256: "source-sha256",
      sizeBytes: 12,
    });

    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "dofek-import-archive",
        ContentType: "text/csv",
        Key: "imports/v1/user-1/strong-csv/source-sha256.csv",
      }),
    );
  });

  it("fails loudly when the archive bucket is not configured", async () => {
    setR2Environment();
    delete process.env.IMPORT_R2_BUCKET;
    const { archiveImportFileToR2 } = await loadModule();

    await expect(
      archiveImportFileToR2("/tmp/strong.csv", {
        contentType: "text/csv",
        extension: ".csv",
        importType: "strong-csv",
        userId: "user-1",
      }),
    ).rejects.toThrow("IMPORT_R2_BUCKET");
  });
});
