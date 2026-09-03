import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeWithSchema: vi.fn() }));

vi.mock("./typed-sql.ts", () => ({ executeWithSchema: mocks.executeWithSchema }));

import {
  abortFileUpload,
  claimFileUploadForProcessing,
  completeFileUploadProcessing,
  createFileUpload,
  expireFileUpload,
  failFileUploadProcessing,
  fileUploadObjectKeyExists,
  findFileUploadForUser,
  isFileUploadRateAllowed,
  listFileUploadsForReconciliation,
  listPendingFileUploadOutboxRequests,
  markFileUploadObjectUploaded,
  markFileUploadOutboxDispatched,
  markFileUploadUploading,
  queueCompletedFileUpload,
  recordFileUploadCompletionParts,
  requeueStuckFileUpload,
  retryFailedFileUpload,
  updateFileUploadProgress,
  withLockedFileUpload,
} from "./file-upload.ts";

const uploadId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const importJobId = `file-import-${uploadId}`;
const now = new Date("2026-07-20T00:00:00Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: uploadId,
    user_id: userId,
    import_type: "garmin-dump",
    object_key: `imports/${userId}/${uploadId}/source`,
    original_filename: "garmin.zip",
    content_type: "application/zip",
    expected_size_bytes: 100,
    expected_sha256: "a".repeat(64),
    verified_sha256: null,
    r2_multipart_upload_id: null,
    state: "initiated",
    version: 0,
    part_size_bytes: 5,
    completion_parts: null,
    import_job_id: null,
    import_since: new Date(0),
    weight_unit: null,
    timezone: null,
    progress_percent: 0,
    error_code: null,
    error_message: null,
    created_at: now,
    updated_at: now,
    expires_at: new Date("2030-01-01T00:00:00Z"),
    completed_at: null,
    object_deleted_at: null,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: uploadId,
    userId,
    importType: "garmin-dump" as const,
    objectKey: `imports/${userId}/${uploadId}/source`,
    originalFilename: "garmin.zip",
    contentType: "application/zip",
    expectedSizeBytes: 100,
    expectedSha256: "a".repeat(64),
    partSizeBytes: 5,
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    since: new Date(0),
    timezone: null,
    ...overrides,
  };
}

const database = { execute: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("file upload repository", () => {
  it("maps every persisted upload field", async () => {
    const persisted = row({
      verified_sha256: "b".repeat(64),
      r2_multipart_upload_id: "multipart-1",
      state: "completed",
      version: 4,
      completion_parts: [{ partNumber: 1, etag: "etag" }],
      import_job_id: importJobId,
      weight_unit: "kg",
      timezone: null,
      progress_percent: 100,
      error_code: "code",
      error_message: "message",
      completed_at: now,
      object_deleted_at: null,
    });
    mocks.executeWithSchema.mockResolvedValue([persisted]);

    await expect(findFileUploadForUser(database, uploadId, userId)).resolves.toEqual({
      id: uploadId,
      userId,
      importType: "garmin-dump",
      objectKey: persisted.object_key,
      originalFilename: "garmin.zip",
      contentType: "application/zip",
      expectedSizeBytes: 100,
      expectedSha256: "a".repeat(64),
      verifiedSha256: "b".repeat(64),
      r2MultipartUploadId: "multipart-1",
      state: "completed",
      version: 4,
      partSizeBytes: 5,
      completionParts: [{ partNumber: 1, etag: "etag" }],
      importJobId,
      since: new Date(0),
      weightUnit: "kg",
      timezone: null,
      progressPercent: 100,
      errorCode: "code",
      errorMessage: "message",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      completedAt: now,
      objectDeletedAt: null,
    });
  });

  it("returns null when an owned upload does not exist", async () => {
    mocks.executeWithSchema.mockResolvedValue([]);
    await expect(findFileUploadForUser(database, uploadId, userId)).resolves.toBeNull();
  });

  it("creates a new upload and returns its mapped row", async () => {
    mocks.executeWithSchema.mockResolvedValue([row()]);
    await expect(createFileUpload(database, input())).resolves.toMatchObject({ id: uploadId });
    expect(mocks.executeWithSchema).toHaveBeenCalledOnce();
  });

  it("returns an idempotent initiation with identical metadata", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    await expect(createFileUpload(database, input())).resolves.toMatchObject({ id: uploadId });
  });

  it("preserves a persisted timezone on an idempotent retry that omits it", async () => {
    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ timezone: "America/Los_Angeles" })]);

    await expect(createFileUpload(database, input({ timezone: undefined }))).resolves.toMatchObject(
      {
        timezone: "America/Los_Angeles",
      },
    );
  });

  it.each([
    ["importType", "fit-file"],
    ["objectKey", "different"],
    ["originalFilename", "different.zip"],
    ["contentType", "text/plain"],
    ["expectedSizeBytes", 101],
    ["expectedSha256", "b".repeat(64)],
    ["partSizeBytes", 6],
    ["since", new Date(1)],
    ["weightUnit", "kg"],
    ["timezone", "America/Los_Angeles"],
  ])("rejects idempotent initiation when %s differs", async (field, value) => {
    mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    await expect(createFileUpload(database, input({ [field]: value }))).rejects.toThrow(
      "different metadata",
    );
  });

  it("rejects an upload ID owned by another user", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(createFileUpload(database, input())).rejects.toThrow(
      "already belongs to another user",
    );
  });

  it("records completion parts and accepts an identical finalized retry", async () => {
    const parts = [{ partNumber: 1, etag: "etag" }];
    mocks.executeWithSchema.mockResolvedValueOnce([row({ completion_parts: parts })]);
    await expect(
      recordFileUploadCompletionParts(database, uploadId, userId, parts),
    ).resolves.toMatchObject({ completionParts: parts });

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "uploaded", completion_parts: parts })]);
    await expect(
      recordFileUploadCompletionParts(database, uploadId, userId, parts),
    ).resolves.toMatchObject({ state: "uploaded" });
  });

  it("rejects completion parts for missing, wrong-state, or different uploads", async () => {
    const parts = [{ partNumber: 1, etag: "etag" }];
    mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(
      recordFileUploadCompletionParts(database, uploadId, userId, parts),
    ).rejects.toThrow("was not found");

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "initiated" })]);
    await expect(
      recordFileUploadCompletionParts(database, uploadId, userId, parts),
    ).rejects.toThrow("must be uploading");

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        row({ state: "uploaded", completion_parts: [{ partNumber: 2, etag: "other" }] }),
      ]);
    await expect(
      recordFileUploadCompletionParts(database, uploadId, userId, parts),
    ).rejects.toThrow("must be uploading");
  });

  it("rejects every active transition exactly when the upload expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ expires_at: now, state: "uploading" })]);
    await expect(
      recordFileUploadCompletionParts(database, uploadId, userId, [
        { partNumber: 1, etag: "etag" },
      ]),
    ).rejects.toThrow("has expired");

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ expires_at: now, state: "initiated" })]);
    await expect(
      markFileUploadUploading(database, uploadId, userId, "multipart-1"),
    ).rejects.toThrow("has expired");

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ expires_at: now, state: "uploaded" })]);
    await expect(
      queueCompletedFileUpload(database, uploadId, userId, { importJobId, objectSizeBytes: 100 }),
    ).rejects.toThrow("has expired");

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ expires_at: now, state: "uploading" })]);
    await expect(markFileUploadObjectUploaded(database, uploadId, userId)).rejects.toThrow(
      "has expired",
    );
  });

  it("supports idempotent abort retries and rejects missing or terminal uploads", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([row({ state: "aborted" })]);
    await expect(abortFileUpload(database, uploadId, userId)).resolves.toMatchObject({
      state: "aborted",
    });

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "aborted" })]);
    await expect(abortFileUpload(database, uploadId, userId)).resolves.toMatchObject({
      state: "aborted",
    });

    mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(abortFileUpload(database, uploadId, userId)).rejects.toThrow("was not found");

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "completed" })]);
    await expect(abortFileUpload(database, uploadId, userId)).rejects.toThrow(
      "cannot be aborted from completed",
    );
  });

  it("marks uploads as uploading and rejects invalid transitions", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([row({ state: "uploading" })]);
    await expect(
      markFileUploadUploading(database, uploadId, userId, "multipart-1"),
    ).resolves.toMatchObject({ state: "uploading" });

    mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(
      markFileUploadUploading(database, uploadId, userId, "multipart-1"),
    ).rejects.toThrow("was not found");

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "completed" })]);
    await expect(
      markFileUploadUploading(database, uploadId, userId, "multipart-1"),
    ).rejects.toThrow("cannot transition from completed to uploading");
  });

  it("queues uploaded files and handles every idempotency error", async () => {
    const completion = { importJobId, objectSizeBytes: 100 };
    mocks.executeWithSchema.mockResolvedValueOnce([
      row({ state: "queued", import_job_id: importJobId }),
    ]);
    await expect(
      queueCompletedFileUpload(database, uploadId, userId, completion),
    ).resolves.toMatchObject({ state: "queued" });

    for (const state of ["queued", "processing", "completed"]) {
      mocks.executeWithSchema
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row({ state, import_job_id: importJobId })]);
      await expect(
        queueCompletedFileUpload(database, uploadId, userId, completion),
      ).resolves.toMatchObject({ state });
    }

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "uploaded", expected_size_bytes: 99 })]);
    await expect(queueCompletedFileUpload(database, uploadId, userId, completion)).rejects.toThrow(
      "size mismatch: expected 99, received 100",
    );

    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "initiated" })]);
    await expect(queueCompletedFileUpload(database, uploadId, userId, completion)).rejects.toThrow(
      "must be uploaded before queueing",
    );
  });

  it("supports idempotent object completion retries and rejects invalid states", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([row({ state: "uploaded" })]);
    await expect(markFileUploadObjectUploaded(database, uploadId, userId)).resolves.toMatchObject({
      state: "uploaded",
    });
    for (const state of ["uploaded", "queued", "processing", "completed"]) {
      mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([row({ state })]);
      await expect(markFileUploadObjectUploaded(database, uploadId, userId)).resolves.toMatchObject(
        {
          state,
        },
      );
    }
    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "initiated" })]);
    await expect(markFileUploadObjectUploaded(database, uploadId, userId)).rejects.toThrow(
      "cannot transition from initiated to uploaded",
    );
  });

  it("lists and maps pending outbox requests with a validated limit", async () => {
    mocks.executeWithSchema.mockResolvedValue([
      {
        upload_id: uploadId,
        import_job_id: importJobId,
        import_type: "garmin-dump",
        user_id: userId,
      },
    ]);
    await expect(listPendingFileUploadOutboxRequests(database, 10)).resolves.toEqual([
      { uploadId, importJobId, importType: "garmin-dump", userId },
    ]);
    await expect(listPendingFileUploadOutboxRequests(database, 0)).rejects.toThrow();
    await expect(listPendingFileUploadOutboxRequests(database, 1_001)).rejects.toThrow();
  });

  it("claims queued uploads and handles processing retries", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([row({ state: "processing" })]);
    await expect(
      claimFileUploadForProcessing(database, uploadId, importJobId),
    ).resolves.toMatchObject({ state: "processing" });
    for (const state of ["processing", "completed"]) {
      mocks.executeWithSchema
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row({ state, import_job_id: importJobId })]);
      await expect(
        claimFileUploadForProcessing(database, uploadId, importJobId),
      ).resolves.toMatchObject({ state });
    }
    mocks.executeWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(claimFileUploadForProcessing(database, uploadId, importJobId)).rejects.toThrow(
      "was not found for job",
    );
    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "failed", import_job_id: importJobId })]);
    await expect(claimFileUploadForProcessing(database, uploadId, importJobId)).rejects.toThrow(
      "cannot be processed from failed",
    );
  });

  it("validates progress and completion digests before writing", async () => {
    database.execute.mockResolvedValue([]);
    await updateFileUploadProgress(database, uploadId, 50);
    await completeFileUploadProcessing(database, uploadId, "a".repeat(64));
    expect(database.execute).toHaveBeenCalledTimes(2);
    await expect(updateFileUploadProgress(database, uploadId, -1)).rejects.toThrow();
    await expect(updateFileUploadProgress(database, uploadId, 101)).rejects.toThrow();
    await expect(completeFileUploadProcessing(database, uploadId, "invalid")).rejects.toThrow();
  });

  it("runs direct lifecycle and outbox updates", async () => {
    database.execute.mockResolvedValue([]);
    mocks.executeWithSchema.mockResolvedValue([]);
    await markFileUploadOutboxDispatched(database, uploadId);
    await failFileUploadProcessing(database, uploadId, "INVALID", "bad upload");
    expect(await expireFileUpload(database, uploadId)).toBe(false);
    expect(await requeueStuckFileUpload(database, uploadId)).toBe(false);
    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(mocks.executeWithSchema).toHaveBeenCalledTimes(2);
  });

  it("returns true when expire and requeue match an existing row", async () => {
    mocks.executeWithSchema.mockResolvedValue([{ id: uploadId }]);
    expect(await expireFileUpload(database, uploadId)).toBe(true);
    expect(await requeueStuckFileUpload(database, uploadId)).toBe(true);
  });

  it("atomically retries a retained failed upload with corrected import metadata", async () => {
    const retryJobId = `file-import-retry-${uploadId}`;
    mocks.executeWithSchema.mockResolvedValueOnce([
      row({
        state: "queued",
        import_job_id: retryJobId,
        import_type: "strong-csv",
        weight_unit: "lbs",
        timezone: "America/Los_Angeles",
      }),
    ]);

    await expect(
      retryFailedFileUpload(database, {
        uploadId,
        userId,
        importJobId: retryJobId,
        weightUnit: "lbs",
        timezone: "America/Los_Angeles",
      }),
    ).resolves.toMatchObject({
      state: "queued",
      importJobId: retryJobId,
      weightUnit: "lbs",
      timezone: "America/Los_Angeles",
    });
    expect(mocks.executeWithSchema).toHaveBeenCalledTimes(1);
  });

  it("holds a row lock while a retained upload operation runs", async () => {
    const transaction = { execute: vi.fn() };
    const transactionalDatabase = {
      execute: vi.fn(),
      transaction: vi.fn(async (operation) => operation(transaction)),
    };
    mocks.executeWithSchema.mockResolvedValueOnce([row({ state: "failed" })]);
    const operation = vi.fn(async (_transaction, upload) => upload.state);

    await expect(withLockedFileUpload(transactionalDatabase, uploadId, operation)).resolves.toBe(
      "failed",
    );
    expect(operation).toHaveBeenCalledWith(transaction, expect.objectContaining({ id: uploadId }));
  });

  it("fails loudly when a failed upload cannot be retried", async () => {
    mocks.executeWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ state: "failed", object_deleted_at: now })]);
    await expect(
      retryFailedFileUpload(database, {
        uploadId,
        userId,
        importJobId: `file-import-retry-${uploadId}`,
      }),
    ).rejects.toThrow("source object has already been deleted");
  });

  it("lists reconciliation candidates and validates its limit", async () => {
    mocks.executeWithSchema.mockResolvedValue([row({ state: "uploaded" })]);
    await expect(listFileUploadsForReconciliation(database, 20)).resolves.toEqual([
      expect.objectContaining({ id: uploadId, state: "uploaded" }),
    ]);
    await expect(listFileUploadsForReconciliation(database, 0)).rejects.toThrow();
  });

  it("checks object existence and both operation rate limits", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([{ exists: true }]);
    await expect(fileUploadObjectKeyExists(database, "key")).resolves.toBe(true);
    mocks.executeWithSchema.mockResolvedValueOnce([]);
    await expect(fileUploadObjectKeyExists(database, "missing")).resolves.toBe(false);
    mocks.executeWithSchema.mockResolvedValueOnce([{ allowed: true }]);
    await expect(isFileUploadRateAllowed(database, userId, "initiate")).resolves.toBe(true);
    mocks.executeWithSchema.mockResolvedValueOnce([{ allowed: false }]);
    await expect(isFileUploadRateAllowed(database, userId, "complete")).resolves.toBe(false);
    mocks.executeWithSchema.mockResolvedValueOnce([]);
    await expect(isFileUploadRateAllowed(database, userId, "complete")).resolves.toBe(false);
  });
});
