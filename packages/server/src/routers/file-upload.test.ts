import { initTRPC } from "@trpc/server";
import type { FileUpload } from "dofek/db/file-upload";
import type { ImportUploadStorage } from "dofek/file-upload-storage";
import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", () => {
  const trpc = initTRPC.context<{ db: unknown; userId: string }>().create();
  return { protectedProcedure: trpc.procedure, router: trpc.router };
});

const { createFileUploadRouter } = await import("./file-upload.ts");

function upload(overrides: Partial<FileUpload> = {}): FileUpload {
  const id = "00000000-0000-4000-8000-0000000000e1";
  return {
    id,
    userId: "00000000-0000-4000-8000-0000000000e2",
    importType: "garmin-dump",
    objectKey: `imports/00000000-0000-4000-8000-0000000000e2/${id}/source`,
    originalFilename: "garmin.zip",
    contentType: "application/zip",
    expectedSizeBytes: 20 * 1024 * 1024,
    expectedSha256: "a".repeat(64),
    verifiedSha256: null,
    r2MultipartUploadId: "multipart-1",
    state: "uploading",
    version: 1,
    partSizeBytes: 16 * 1024 * 1024,
    completionParts: null,
    importJobId: null,
    since: new Date(0),
    weightUnit: null,
    progressPercent: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-07-19T00:00:00Z"),
    updatedAt: new Date("2026-07-19T00:00:00Z"),
    expiresAt: new Date("2026-07-20T00:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}

function setup(currentUpload = upload()) {
  const storage: ImportUploadStorage = {
    abortMultipartUpload: vi.fn(async () => undefined),
    authorizeUploadPart: vi.fn(async ({ partNumber }) => ({
      partNumber,
      url: `https://r2.example/part/${partNumber}`,
      expiresAt: "2026-07-19T00:15:00.000Z",
    })),
    completeMultipartUpload: vi.fn(async () => undefined),
    createMultipartUpload: vi.fn(async () => "multipart-1"),
    deleteObject: vi.fn(async () => undefined),
    getObjectStream: vi.fn(),
    headObject: vi.fn(async () => ({ sizeBytes: currentUpload.expectedSizeBytes })),
    listParts: vi.fn(async () => [
      { partNumber: 1, etag: '"etag-1"', sizeBytes: 16 * 1024 * 1024 },
      { partNumber: 2, etag: '"etag-2"', sizeBytes: 4 * 1024 * 1024 },
    ]),
    listObjects: vi.fn(async () => []),
  };
  const repository = {
    abort: vi.fn(async () => upload({ ...currentUpload, state: "aborted" })),
    create: vi.fn(async () => currentUpload),
    find: vi.fn(async () => currentUpload),
    markUploading: vi.fn(async () => currentUpload),
    markUploaded: vi.fn(async () => upload({ ...currentUpload, state: "uploaded" })),
    queue: vi.fn(async () =>
      upload({
        ...currentUpload,
        state: "queued",
        importJobId: `file-import-${currentUpload.id}`,
      }),
    ),
    recordCompletionParts: vi.fn(async () => currentUpload),
    rateAllowed: vi.fn(async () => true),
  };
  const caller = createTestCallerFactory(createFileUploadRouter({ repository, storage }))({
    db: {},
    userId: currentUpload.userId,
  });
  return { caller, repository, storage };
}

describe("fileUploadRouter", () => {
  it("authorizes only the exact expected part size", async () => {
    const { caller, storage } = setup();

    const result = await caller.authorizeParts({
      uploadId: upload().id,
      partNumbers: [1, 2],
    });

    expect(result.parts).toHaveLength(2);
    expect(storage.authorizeUploadPart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ partNumber: 2, contentLength: 4 * 1024 * 1024 }),
    );
  });

  it("returns stable authorization shape when the same part is requested again", async () => {
    const { caller, storage } = setup();

    const first = await caller.authorizeParts({ uploadId: upload().id, partNumbers: [1] });
    const repeated = await caller.authorizeParts({ uploadId: upload().id, partNumbers: [1] });

    expect(first.parts[0]?.partNumber).toBe(1);
    expect(repeated.parts[0]?.partNumber).toBe(1);
    expect(storage.authorizeUploadPart).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed authoritative part list", async () => {
    const { caller, storage } = setup();
    vi.mocked(storage.listParts).mockResolvedValue([
      { partNumber: 1, etag: '"etag-1"', sizeBytes: 16 * 1024 * 1024 },
      { partNumber: 3, etag: '"etag-3"', sizeBytes: 4 * 1024 * 1024 },
    ]);

    await expect(
      caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 3, etag: '"etag-3"' },
        ],
      }),
    ).rejects.toThrow("consecutive");
  });

  it("returns the persisted job for repeated completion", async () => {
    const completed = upload({ state: "queued", importJobId: `file-import-${upload().id}` });
    const { caller, storage } = setup(completed);

    const result = await caller.complete({ uploadId: completed.id, parts: [] });

    expect(result.importJobId).toBe(completed.importJobId);
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("converges concurrent completion when R2 reports the multipart upload already completed", async () => {
    const { caller, storage, repository } = setup();
    vi.mocked(storage.completeMultipartUpload)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("NoSuchUpload"));
    const input = {
      uploadId: upload().id,
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    };

    const results = await Promise.all([caller.complete(input), caller.complete(input)]);

    expect(results.map((result) => result.importJobId)).toEqual([
      `file-import-${upload().id}`,
      `file-import-${upload().id}`,
    ]);
    expect(repository.queue).toHaveBeenCalledTimes(2);
  });

  it("rejects a part with the wrong authoritative size", async () => {
    const { caller, storage } = setup();
    vi.mocked(storage.listParts).mockResolvedValue([
      { partNumber: 1, etag: '"etag-1"', sizeBytes: 15 * 1024 * 1024 },
      { partNumber: 2, etag: '"etag-2"', sizeBytes: 5 * 1024 * 1024 },
    ]);

    await expect(
      caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      }),
    ).rejects.toThrow("invalid size");
  });
});
