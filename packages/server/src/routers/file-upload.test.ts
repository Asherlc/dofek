import { initTRPC } from "@trpc/server";
import type { FileUpload } from "dofek/db/file-upload";
import type { ImportUploadStorage } from "dofek/file-upload-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const metrics = vi.hoisted(() => ({
  bytes: vi.fn(),
  duration: vi.fn(),
  lifecycle: vi.fn(),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("dofek/file-upload-metrics", () => ({
  fileUploadBytesTotal: { add: metrics.bytes },
  fileUploadCompletionDuration: { record: metrics.duration },
  fileUploadLifecycleTotal: { add: metrics.lifecycle },
}));
vi.mock("@sentry/node", () => ({ captureException: sentry.captureException }));

vi.mock("../trpc.ts", () => {
  const trpc = initTRPC.context<{ db: unknown; userId: string }>().create();
  return { protectedProcedure: trpc.procedure, router: trpc.router };
});

const { createFileUploadRouter } = await import("./file-upload.ts");

beforeEach(() => {
  vi.clearAllMocks();
});

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
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    completedAt: null,
    objectDeletedAt: null,
    ...overrides,
  };
}

function setup(currentUpload = upload()) {
  const transaction = { execute: vi.fn(), select: vi.fn() };
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
  const withUserWriteFence = vi.fn(
    async (
      _database,
      _userId,
      operation: (database: {
        execute: CallableVitestMock;
        select: CallableVitestMock;
      }) => Promise<unknown>,
    ) => operation(transaction),
  );
  const caller = createTestCallerFactory(
    createFileUploadRouter({
      repository,
      storage,
      withUserWriteFence,
    }),
  )({
    db: {},
    userId: currentUpload.userId,
  });
  return { caller, repository, storage, transaction, withUserWriteFence };
}

interface InitiationInput {
  uploadId: string;
  importType: "garmin-dump";
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

function initiationInput(overrides: Partial<InitiationInput> = {}): InitiationInput {
  return {
    uploadId: upload().id,
    importType: "garmin-dump",
    filename: "garmin.zip",
    contentType: "application/zip",
    sizeBytes: 20 * 1024 * 1024,
    sha256: "a".repeat(64),
    ...overrides,
  };
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

  it("initiates a new multipart upload with normalized metadata", async () => {
    const initiated = upload({ state: "initiated", r2MultipartUploadId: null });
    const uploading = upload();
    const { caller, repository, storage, transaction } = setup(initiated);
    repository.find.mockResolvedValueOnce(null);
    repository.markUploading.mockResolvedValueOnce(uploading);

    const result = await caller.initiate(initiationInput({ contentType: "APPLICATION/ZIP" }));

    expect(repository.rateAllowed).toHaveBeenCalledWith(transaction, initiated.userId, "initiate");
    expect(repository.create).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        id: initiated.id,
        userId: initiated.userId,
        objectKey: initiated.objectKey,
        contentType: "application/zip",
        partSizeBytes: 16 * 1024 * 1024,
        since: new Date(0),
      }),
    );
    expect(storage.createMultipartUpload).toHaveBeenCalledWith(
      initiated.objectKey,
      initiated.contentType,
    );
    expect(repository.markUploading).toHaveBeenCalledWith(
      transaction,
      initiated.id,
      initiated.userId,
      "multipart-1",
    );
    expect(metrics.lifecycle).toHaveBeenCalledWith(1, {
      state: "initiated",
      import_type: "garmin-dump",
    });
    expect(result).toMatchObject({
      uploadId: uploading.id,
      state: "uploading",
      partCount: 2,
      expiresAt: uploading.expiresAt.toISOString(),
    });
  });

  it("holds the account-erasure fence across multipart creation and ownership persistence", async () => {
    const initiated = upload({ state: "initiated", r2MultipartUploadId: null });
    const uploading = upload();
    const { caller, repository, storage, transaction, withUserWriteFence } = setup(initiated);
    repository.find.mockResolvedValueOnce(null);
    repository.markUploading.mockResolvedValueOnce(uploading);

    await caller.initiate(initiationInput());

    expect(withUserWriteFence).toHaveBeenCalledWith({}, initiated.userId, expect.any(Function));
    expect(repository.create).toHaveBeenCalledWith(transaction, expect.any(Object));
    expect(storage.createMultipartUpload).toHaveBeenCalledOnce();
    expect(repository.markUploading).toHaveBeenCalledWith(
      transaction,
      initiated.id,
      initiated.userId,
      "multipart-1",
    );
  });

  it("aborts the multipart upload when the fenced transaction fails to commit", async () => {
    const initiated = upload({ state: "initiated", r2MultipartUploadId: null });
    const { caller, storage, transaction, withUserWriteFence } = setup(initiated);
    withUserWriteFence.mockImplementationOnce(
      async (_database, _userId, operation: (database: typeof transaction) => Promise<unknown>) => {
        await operation(transaction);
        throw new Error("commit failed");
      },
    );

    await expect(caller.initiate(initiationInput())).rejects.toThrow("commit failed");
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(initiated.objectKey, "multipart-1");
  });

  it("uses a seven-day window for incremental Apple Health imports", async () => {
    const initiated = upload({
      importType: "apple-health",
      originalFilename: "export.xml",
      contentType: "application/xml",
      state: "initiated",
      r2MultipartUploadId: null,
    });
    const { caller, repository, transaction } = setup(initiated);
    repository.find.mockResolvedValueOnce(null);
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-19T00:00:00Z").getTime());

    await caller.initiate({
      uploadId: initiated.id,
      importType: "apple-health",
      filename: "export.XML",
      contentType: "APPLICATION/XML",
      sizeBytes: initiated.expectedSizeBytes,
      sha256: initiated.expectedSha256,
    });

    expect(repository.create).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ since: new Date("2026-07-12T00:00:00Z") }),
    );
  });

  it("reuses the persisted Apple Health import window when initiation is retried", async () => {
    const persistedSince = new Date("2026-07-12T00:00:00Z");
    const existing = upload({
      importType: "apple-health",
      originalFilename: "export.xml",
      contentType: "application/xml",
      since: persistedSince,
    });
    const { caller, repository, transaction } = setup(existing);
    repository.find.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    const dateNow = vi.spyOn(Date, "now");
    const input = {
      uploadId: existing.id,
      importType: "apple-health",
      filename: existing.originalFilename,
      contentType: existing.contentType,
      sizeBytes: existing.expectedSizeBytes,
      sha256: existing.expectedSha256,
    } satisfies Parameters<typeof caller.initiate>[0];

    try {
      dateNow.mockReturnValue(new Date("2026-07-19T00:00:00Z").getTime());
      await caller.initiate(input);
      dateNow.mockReturnValue(new Date("2026-07-19T00:01:00Z").getTime());
      await caller.initiate(input);

      expect(repository.create).toHaveBeenNthCalledWith(
        2,
        transaction,
        expect.objectContaining({ since: persistedSince }),
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it("uses epoch for full Apple Health imports and preserves an absent Strong weight unit", async () => {
    const apple = upload({
      importType: "apple-health",
      originalFilename: "export.zip",
      state: "initiated",
      r2MultipartUploadId: null,
    });
    const appleSetup = setup(apple);
    appleSetup.repository.find.mockResolvedValueOnce(null);
    await appleSetup.caller.initiate({
      uploadId: apple.id,
      importType: "apple-health",
      filename: "export.zip",
      contentType: "application/zip",
      sizeBytes: apple.expectedSizeBytes,
      sha256: apple.expectedSha256,
      fullSync: true,
    });
    expect(appleSetup.repository.create).toHaveBeenCalledWith(
      appleSetup.transaction,
      expect.objectContaining({ since: new Date(0), weightUnit: undefined }),
    );

    const strong = upload({
      importType: "strong-csv",
      originalFilename: "strong.csv",
      contentType: "text/csv",
      state: "initiated",
      r2MultipartUploadId: null,
    });
    const strongSetup = setup(strong);
    strongSetup.repository.find.mockResolvedValueOnce(null);
    await strongSetup.caller.initiate({
      uploadId: strong.id,
      importType: "strong-csv",
      filename: "strong.csv",
      contentType: "text/csv",
      sizeBytes: strong.expectedSizeBytes,
      sha256: strong.expectedSha256,
    });
    expect(strongSetup.repository.create).toHaveBeenCalledWith(
      strongSetup.transaction,
      expect.objectContaining({ weightUnit: undefined }),
    );
  });

  it("rejects invalid import metadata and initiation rate limits", async () => {
    const extensionSetup = setup();
    await expect(
      extensionSetup.caller.initiate(initiationInput({ filename: "garmin.csv" })),
    ).rejects.toThrow("Invalid garmin-dump file extension");

    const contentSetup = setup();
    await expect(
      contentSetup.caller.initiate(initiationInput({ contentType: "text/csv" })),
    ).rejects.toThrow("Invalid garmin-dump content type");

    const rateSetup = setup();
    rateSetup.repository.find.mockResolvedValueOnce(null);
    rateSetup.repository.rateAllowed.mockResolvedValueOnce(false);
    await expect(rateSetup.caller.initiate(initiationInput())).rejects.toThrow(
      "Too many uploads initiated",
    );
    expect(rateSetup.repository.create).not.toHaveBeenCalled();
  });

  it("reuses an existing upload without consuming initiation rate capacity", async () => {
    const existing = upload();
    const { caller, repository, storage } = setup(existing);

    await expect(caller.initiate(initiationInput())).resolves.toMatchObject({ state: "uploading" });

    expect(repository.rateAllowed).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    expect(metrics.lifecycle).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ state: "initiated" }),
    );
  });

  it("converges a concurrent multipart initiation and aborts the losing R2 upload", async () => {
    const initiated = upload({ state: "initiated", r2MultipartUploadId: null });
    const concurrent = upload({ state: "uploading", r2MultipartUploadId: "winner" });
    const { caller, repository, storage } = setup(initiated);
    repository.find.mockResolvedValueOnce(null).mockResolvedValueOnce(concurrent);
    repository.markUploading.mockRejectedValueOnce(new Error("state changed"));

    await expect(caller.initiate(initiationInput())).resolves.toMatchObject({ state: "uploading" });

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(initiated.objectKey, "multipart-1");
  });

  it("rethrows a failed multipart transition when no concurrent upload won", async () => {
    const initiated = upload({ state: "initiated", r2MultipartUploadId: null });
    const { caller, repository, storage } = setup(initiated);
    repository.find.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    repository.markUploading.mockRejectedValueOnce(new Error("state changed"));

    await expect(caller.initiate(initiationInput())).rejects.toThrow("state changed");
    expect(storage.abortMultipartUpload).toHaveBeenCalledOnce();
  });

  it("preserves the markUploading error when abortMultipartUpload also fails", async () => {
    const initiated = upload({ state: "initiated", r2MultipartUploadId: null });
    const { caller, repository, storage } = setup(initiated);
    repository.find.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    repository.markUploading.mockRejectedValueOnce(new Error("state changed"));
    vi.mocked(storage.abortMultipartUpload).mockRejectedValueOnce(new Error("R2 abort failed"));

    await expect(caller.initiate(initiationInput())).rejects.toThrow("state changed");
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(2);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: "file-upload-initiate", operation: "abortMultipartUpload" },
      extra: { uploadId: initiated.id, multipartUploadId: "multipart-1" },
    });
  });

  it("accepts content types with parameters", async () => {
    const initiated = upload({ state: "initiated", r2MultipartUploadId: null });
    const uploading = upload();
    const { caller, repository } = setup(initiated);
    repository.find.mockResolvedValueOnce(null);
    repository.markUploading.mockResolvedValueOnce(uploading);

    await expect(
      caller.initiate(initiationInput({ contentType: "application/zip; charset=utf-8" })),
    ).resolves.toMatchObject({ state: "uploading" });
  });

  it("rejects authorization for missing, inactive, and invalid upload parts", async () => {
    const missing = setup();
    missing.repository.find.mockResolvedValueOnce(null);
    await expect(
      missing.caller.authorizeParts({ uploadId: upload().id, partNumbers: [1] }),
    ).rejects.toThrow("was not found");

    const inactive = setup(upload({ state: "initiated", r2MultipartUploadId: null }));
    await expect(
      inactive.caller.authorizeParts({ uploadId: upload().id, partNumbers: [1] }),
    ).rejects.toThrow("not accepting parts");

    const invalid = setup();
    await expect(
      invalid.caller.authorizeParts({ uploadId: upload().id, partNumbers: [3] }),
    ).rejects.toThrow("Invalid upload part 3");
  });

  it("rejects part authorization after the upload session expires", async () => {
    const expired = setup(upload({ expiresAt: new Date(0) }));

    await expect(
      expired.caller.authorizeParts({ uploadId: upload().id, partNumbers: [1] }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Upload session has expired",
    });
    expect(expired.storage.authorizeUploadPart).not.toHaveBeenCalled();
  });

  it("deduplicates authorized part numbers", async () => {
    const { caller, storage } = setup();

    const result = await caller.authorizeParts({ uploadId: upload().id, partNumbers: [1, 1] });

    expect(result.parts).toHaveLength(1);
    expect(storage.authorizeUploadPart).toHaveBeenCalledOnce();
  });

  it("resumes active uploads from R2 and terminal uploads without R2", async () => {
    const active = setup();
    await expect(active.caller.resume({ uploadId: upload().id })).resolves.toMatchObject({
      parts: [{ partNumber: 1 }, { partNumber: 2 }],
    });
    expect(active.storage.listParts).toHaveBeenCalledWith(upload().objectKey, "multipart-1");
    expect(metrics.lifecycle).toHaveBeenCalledWith(1, {
      state: "resumed",
      import_type: "garmin-dump",
    });

    const terminal = setup(upload({ state: "completed", r2MultipartUploadId: null }));
    await expect(terminal.caller.resume({ uploadId: upload().id })).resolves.toMatchObject({
      parts: [],
    });
    expect(terminal.storage.listParts).not.toHaveBeenCalled();
  });

  it("rejects resuming an upload after its session expires", async () => {
    const expired = setup(upload({ expiresAt: new Date(0) }));

    await expect(expired.caller.resume({ uploadId: upload().id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Upload session has expired",
    });
    expect(expired.storage.listParts).not.toHaveBeenCalled();

    const initiated = setup(
      upload({ expiresAt: new Date(0), r2MultipartUploadId: null, state: "initiated" }),
    );
    await expect(initiated.caller.resume({ uploadId: upload().id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Upload session has expired",
    });
  });

  it("rejects completion rate limits and uploads that are not ready", async () => {
    const rate = setup();
    rate.repository.rateAllowed.mockResolvedValueOnce(false);
    await expect(rate.caller.complete({ uploadId: upload().id, parts: [] })).rejects.toThrow(
      "Too many uploads completed",
    );

    const inactive = setup(upload({ state: "initiated", r2MultipartUploadId: null }));
    await expect(inactive.caller.complete({ uploadId: upload().id, parts: [] })).rejects.toThrow(
      "not ready to complete",
    );
  });

  it("rejects completion after the upload session expires", async () => {
    const expired = setup(upload({ expiresAt: new Date(0) }));

    await expect(
      expired.caller.complete({ uploadId: upload().id, parts: [] }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Upload session has expired",
    });
    expect(expired.storage.listParts).not.toHaveBeenCalled();
    expect(expired.repository.recordCompletionParts).not.toHaveBeenCalled();
  });

  it("rejects incomplete parts and ETag mismatches", async () => {
    const incomplete = setup();
    vi.mocked(incomplete.storage.listParts).mockResolvedValueOnce([
      { partNumber: 1, etag: "etag-1", sizeBytes: 16 * 1024 * 1024 },
    ]);
    await expect(
      incomplete.caller.complete({
        uploadId: upload().id,
        parts: [{ partNumber: 1, etag: "etag-1" }],
      }),
    ).rejects.toThrow("incomplete parts");

    const mismatch = setup();
    await expect(
      mismatch.caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: "wrong" },
          { partNumber: 2, etag: "etag-2" },
        ],
      }),
    ).rejects.toThrow("ETag mismatch");
  });

  it("completes, verifies, queues, and records upload metrics", async () => {
    const { caller, repository, storage } = setup();
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-19T00:01:40Z").getTime());

    const result = await caller.complete({
      uploadId: upload().id,
      parts: [
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 1, etag: "etag-1" },
      ],
    });

    expect(repository.recordCompletionParts).toHaveBeenCalledWith(
      expect.objectContaining({
        execute: expect.any(Function),
        select: expect.any(Function),
      }),
      upload().id,
      upload().userId,
      [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    );
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      upload().objectKey,
      "multipart-1",
      [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    );
    expect(repository.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        execute: expect.any(Function),
        select: expect.any(Function),
      }),
      upload().id,
      upload().userId,
      {
        importJobId: `file-import-${upload().id}`,
        objectSizeBytes: upload().expectedSizeBytes,
      },
    );
    expect(metrics.bytes).toHaveBeenCalledWith(upload().expectedSizeBytes, {
      import_type: "garmin-dump",
    });
    expect(metrics.duration).toHaveBeenCalledWith(100, { import_type: "garmin-dump" });
    expect(result).toMatchObject({ state: "queued", importJobId: `file-import-${upload().id}` });
  });

  it("recovers completion when the multipart operation already produced an object", async () => {
    const { caller, storage } = setup();
    vi.mocked(storage.completeMultipartUpload).mockRejectedValueOnce(new Error("NoSuchUpload"));

    await expect(
      caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
        ],
      }),
    ).resolves.toMatchObject({ state: "queued" });
    expect(storage.headObject).toHaveBeenCalledOnce();
  });

  it("preserves the multipart error when object recovery also fails", async () => {
    const { caller, storage } = setup();
    vi.mocked(storage.completeMultipartUpload).mockRejectedValueOnce(new Error("NoSuchUpload"));
    vi.mocked(storage.headObject).mockRejectedValueOnce(new Error("missing"));

    await expect(
      caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
        ],
      }),
    ).rejects.toThrow("NoSuchUpload");
  });

  it("deletes the completed object when durable upload persistence fails", async () => {
    const { caller, repository, storage } = setup();
    repository.markUploaded.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
        ],
      }),
    ).rejects.toThrow("database unavailable");

    expect(storage.deleteObject).toHaveBeenCalledWith(upload().objectKey);
    expect(repository.queue).not.toHaveBeenCalled();
  });

  it("deletes the completed object when the fenced transaction fails to commit", async () => {
    const { caller, storage, transaction, withUserWriteFence } = setup();
    withUserWriteFence.mockImplementationOnce(
      async (_database, _userId, operation: (database: typeof transaction) => Promise<unknown>) => {
        await operation(transaction);
        throw new Error("commit failed");
      },
    );

    await expect(
      caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
        ],
      }),
    ).rejects.toThrow("commit failed");
    expect(storage.deleteObject).toHaveBeenCalledWith(upload().objectKey);
  });

  it("reports failed completed-object compensation without hiding the persistence error", async () => {
    const { caller, repository, storage } = setup();
    const persistenceError = new Error("database unavailable");
    const cleanupError = new Error("R2 delete unavailable");
    repository.queue.mockRejectedValueOnce(persistenceError);
    vi.mocked(storage.deleteObject).mockRejectedValueOnce(cleanupError);

    await expect(
      caller.complete({
        uploadId: upload().id,
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
        ],
      }),
    ).rejects.toThrow("database unavailable");

    expect(storage.deleteObject).toHaveBeenCalledWith(upload().objectKey);
    expect(sentry.captureException).toHaveBeenCalledWith(cleanupError, {
      tags: { source: "file-upload-complete", operation: "deleteCompletedObject" },
      extra: { uploadId: upload().id, objectKey: upload().objectKey },
    });
  });

  it("aborts active uploads and records cancellation", async () => {
    const { caller, repository, storage } = setup();

    await expect(caller.abort({ uploadId: upload().id })).resolves.toMatchObject({
      state: "aborted",
    });

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(upload().objectKey, "multipart-1");
    expect(repository.abort).toHaveBeenCalledWith({}, upload().id, upload().userId);
    expect(metrics.lifecycle).toHaveBeenCalledWith(1, {
      state: "cancelled",
      import_type: "garmin-dump",
    });
  });

  it("returns idempotent aborts and skips R2 for uploads without multipart state", async () => {
    const aborted = setup(upload({ state: "aborted" }));
    await expect(aborted.caller.abort({ uploadId: upload().id })).resolves.toMatchObject({
      state: "aborted",
    });
    expect(aborted.repository.abort).not.toHaveBeenCalled();

    const initiated = setup(upload({ state: "initiated", r2MultipartUploadId: null }));
    await initiated.caller.abort({ uploadId: upload().id });
    expect(initiated.storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(initiated.repository.abort).toHaveBeenCalledOnce();
  });
});
