import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileUpload } from "../src/db/file-upload.ts";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  closeSentry: vi.fn().mockResolvedValue(true),
  endDatabase: vi.fn().mockResolvedValue(undefined),
  findFileUploadForUser: vi.fn(),
  headObject: vi.fn(),
  retryFailedFileUpload: vi.fn(),
  withLockedFileUpload: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  close: mocks.closeSentry,
  init: vi.fn(),
}));
vi.mock("../src/db/file-upload.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/file-upload.ts")>()),
  findFileUploadForUser: mocks.findFileUploadForUser,
  retryFailedFileUpload: mocks.retryFailedFileUpload,
  withLockedFileUpload: mocks.withLockedFileUpload,
}));
vi.mock("../src/db/index.ts", () => ({
  createDatabaseFromEnv: () => ({ $client: { end: mocks.endDatabase } }),
}));
vi.mock("../src/file-upload-storage.ts", () => ({
  createImportUploadStorageFromEnv: () => ({ headObject: mocks.headObject }),
}));
vi.mock("../src/lib/error-reporting.ts", () => ({
  captureException: mocks.captureException,
}));

import { main, parseRetryFailedFileUploadCommand } from "./retry-failed-file-upload.ts";

const required = [
  "--upload-id=00000000-0000-4000-8000-000000000001",
  "--user-id=00000000-0000-4000-8000-000000000002",
];

describe("parseRetryFailedFileUploadCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to a read-only retained-object preflight", () => {
    expect(
      parseRetryFailedFileUploadCommand([
        ...required,
        "--weight-unit=lbs",
        "--timezone=America/Los_Angeles",
      ]),
    ).toEqual({
      execute: false,
      uploadId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      weightUnit: "lbs",
      timezone: "America/Los_Angeles",
    });
  });

  it("requires a stable job ID for an idempotent execute", () => {
    expect(
      parseRetryFailedFileUploadCommand([
        ...required,
        "--execute",
        "--job-id=file-import-repair-20260903-strong",
        "--weight-unit=lbs",
      ]),
    ).toEqual({
      execute: true,
      uploadId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      importJobId: "file-import-repair-20260903-strong",
      weightUnit: "lbs",
    });
    expect(() => parseRetryFailedFileUploadCommand([...required, "--execute"])).toThrow(
      "--job-id is required with --execute",
    );
  });

  it.each([
    { args: required.slice(1), message: "--upload-id" },
    { args: required.slice(0, 1), message: "--user-id" },
    { args: [...required, "--weight-unit=stone"], message: "--weight-unit" },
    { args: [...required, "--timezone= "], message: "--timezone" },
  ])("rejects invalid command arguments", ({ args, message }) => {
    expect(() => parseRetryFailedFileUploadCommand(args)).toThrow(message);
  });

  it("rejects a non-IANA timezone supplied explicitly", () => {
    expect(() =>
      parseRetryFailedFileUploadCommand([...required, "--timezone=Not/A_Timezone"]),
    ).toThrow("valid IANA timezone");
  });

  it("rejects a fixed UTC offset where an IANA timezone is required", () => {
    expect(() => parseRetryFailedFileUploadCommand([...required, "--timezone=+01:00"])).toThrow(
      "valid IANA timezone",
    );
  });

  it("requires corrected Strong metadata even when the failed upload retained old values", async () => {
    const now = new Date("2026-09-03T12:00:00.000Z");
    const upload = {
      id: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      importType: "strong-csv",
      objectKey: "imports/user/strong.csv",
      originalFilename: "strong.csv",
      contentType: "text/csv",
      expectedSizeBytes: 100,
      expectedSha256: "a".repeat(64),
      verifiedSha256: "a".repeat(64),
      r2MultipartUploadId: null,
      state: "failed",
      version: 1,
      partSizeBytes: 5_242_880,
      completionParts: null,
      importJobId: null,
      since: now,
      weightUnit: "kg",
      timezone: "America/New_York",
      progressPercent: 0,
      errorCode: "IMPORT_REJECTED",
      errorMessage: "Incorrect metadata",
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
      completedAt: null,
      objectDeletedAt: null,
    } satisfies FileUpload;
    mocks.findFileUploadForUser.mockResolvedValue(upload);

    await expect(main(required)).rejects.toThrow(
      "Strong CSV retry requires an explicit weight unit",
    );
    expect(mocks.headObject).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.endDatabase).toHaveBeenCalledOnce();
  });
});
