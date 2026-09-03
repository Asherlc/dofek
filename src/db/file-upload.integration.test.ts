import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFileUpload,
  findFileUploadForUser,
  listFileUploadsForReconciliation,
  listPendingFileUploadOutboxRequests,
  markFileUploadObjectDeleted,
  markFileUploadObjectUploaded,
  markFileUploadUploading,
  queueCompletedFileUpload,
  recordFileUploadCompletionParts,
  retryFailedFileUpload,
} from "./file-upload.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("file upload state machine (integration)", () => {
  const userId = "00000000-0000-4000-8000-0000000000d1";
  const otherUserId = "00000000-0000-4000-8000-0000000000d2";
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Upload User'), (${otherUserId}, 'Other Upload User')`);
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  function uploadInput(uploadId = randomUUID()) {
    return {
      id: uploadId,
      userId,
      importType: "garmin-dump" as const,
      objectKey: `imports/${userId}/${uploadId}/source`,
      originalFilename: "garmin-export.zip",
      contentType: "application/zip",
      expectedSizeBytes: 32 * 1024 * 1024,
      expectedSha256: "a".repeat(64),
      partSizeBytes: 16 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      since: new Date(0),
    };
  }

  it("returns the same session for repeated initiation", async () => {
    const input = uploadInput();

    const first = await createFileUpload(testContext.db, input);
    const repeated = await createFileUpload(testContext.db, input);

    expect(repeated).toEqual(first);
    expect(repeated.state).toBe("initiated");
  });

  it("isolates upload lookup by owner", async () => {
    const input = uploadInput();
    await createFileUpload(testContext.db, input);

    expect(await findFileUploadForUser(testContext.db, input.id, otherUserId)).toBeNull();
  });

  it("rejects an invalid state transition", async () => {
    const input = uploadInput();
    await createFileUpload(testContext.db, input);

    await expect(
      queueCompletedFileUpload(testContext.db, input.id, userId, {
        importJobId: `file-import-${input.id}`,
        objectSizeBytes: input.expectedSizeBytes,
      }),
    ).rejects.toThrow("uploaded");
  });

  it("does not finalize or queue an upload after it expires", async () => {
    const input = { ...uploadInput(), expiresAt: new Date(0) };
    await createFileUpload(testContext.db, input);
    await testContext.db.execute(sql`UPDATE fitness.file_upload
      SET state = 'uploading', r2_multipart_upload_id = 'r2-multipart-id'
      WHERE id = ${input.id}::uuid`);

    await expect(
      recordFileUploadCompletionParts(testContext.db, input.id, userId, [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
      ]),
    ).rejects.toThrow("has expired");
    expect((await findFileUploadForUser(testContext.db, input.id, userId))?.state).toBe(
      "uploading",
    );

    await testContext.db.execute(sql`UPDATE fitness.file_upload
      SET state = 'uploaded'
      WHERE id = ${input.id}::uuid`);
    await expect(
      queueCompletedFileUpload(testContext.db, input.id, userId, {
        importJobId: `file-import-${input.id}`,
        objectSizeBytes: input.expectedSizeBytes,
      }),
    ).rejects.toThrow("has expired");
    expect((await findFileUploadForUser(testContext.db, input.id, userId))?.state).toBe("uploaded");
  });

  it("queues exactly one outbox event under concurrent completion", async () => {
    const input = uploadInput();
    await createFileUpload(testContext.db, input);
    await markFileUploadUploading(testContext.db, input.id, userId, "r2-multipart-id");
    await markFileUploadObjectUploaded(testContext.db, input.id, userId);
    const completion = {
      importJobId: `file-import-${input.id}`,
      objectSizeBytes: input.expectedSizeBytes,
    };

    const [first, repeated] = await Promise.all([
      queueCompletedFileUpload(testContext.db, input.id, userId, completion),
      queueCompletedFileUpload(testContext.db, input.id, userId, completion),
    ]);

    expect(first.importJobId).toBe(completion.importJobId);
    expect(repeated).toEqual(first);
    const rows = await testContext.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count
          FROM fitness.file_upload_outbox
          WHERE upload_id = ${input.id}::uuid`,
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("atomically requeues a retained failed upload with corrected metadata", async () => {
    const input = {
      ...uploadInput(),
      importType: "strong-csv" as const,
      originalFilename: "strong.csv",
      contentType: "text/csv",
    };
    await createFileUpload(testContext.db, input);
    await markFileUploadUploading(testContext.db, input.id, userId, "r2-multipart-id");
    await markFileUploadObjectUploaded(testContext.db, input.id, userId);
    await queueCompletedFileUpload(testContext.db, input.id, userId, {
      importJobId: `file-import-${input.id}`,
      objectSizeBytes: input.expectedSizeBytes,
    });
    await testContext.db.execute(sql`UPDATE fitness.file_upload
      SET state = 'failed', error_code = 'IMPORT_REJECTED', error_message = 'Missing unit',
          expires_at = to_timestamp(0)
      WHERE id = ${input.id}::uuid`);
    await testContext.db.execute(sql`UPDATE fitness.file_upload_outbox
      SET status = 'failed', failure_reason = 'Missing unit', failed_at = now()
      WHERE upload_id = ${input.id}::uuid`);

    const retryJobId = `file-import-retry-${input.id}`;
    const retried = await retryFailedFileUpload(testContext.db, {
      uploadId: input.id,
      userId,
      importJobId: retryJobId,
      weightUnit: "lbs",
      timezone: "America/Los_Angeles",
    });

    expect(retried).toMatchObject({
      state: "queued",
      importJobId: retryJobId,
      weightUnit: "lbs",
      timezone: "America/Los_Angeles",
      errorCode: null,
      errorMessage: null,
    });
    await expect(
      retryFailedFileUpload(testContext.db, {
        uploadId: input.id,
        userId,
        importJobId: retryJobId,
        weightUnit: "lbs",
        timezone: "America/Los_Angeles",
      }),
    ).resolves.toEqual(retried);
    await expect(listPendingFileUploadOutboxRequests(testContext.db, 100)).resolves.toContainEqual({
      uploadId: input.id,
      importJobId: retryJobId,
      importType: "strong-csv",
      userId,
    });
  });

  it("does not repeatedly reconcile a terminal upload after its object is deleted", async () => {
    const input = uploadInput();
    await createFileUpload(testContext.db, input);
    await testContext.db.execute(sql`UPDATE fitness.file_upload
      SET state = 'completed', updated_at = now() - interval '8 days'
      WHERE id = ${input.id}::uuid`);

    expect(
      (await listFileUploadsForReconciliation(testContext.db)).map((upload) => upload.id),
    ).toContain(input.id);

    await markFileUploadObjectDeleted(testContext.db, input.id);

    expect(
      (await listFileUploadsForReconciliation(testContext.db)).map((upload) => upload.id),
    ).not.toContain(input.id);
  });

  it("excludes pending uploads owned by an account being erased", async () => {
    const fencedUpload = uploadInput();
    const visibleUpload = {
      ...uploadInput(),
      userId: otherUserId,
    };
    await createFileUpload(testContext.db, fencedUpload);
    await markFileUploadUploading(
      testContext.db,
      fencedUpload.id,
      fencedUpload.userId,
      "fenced-multipart",
    );
    await markFileUploadObjectUploaded(testContext.db, fencedUpload.id, fencedUpload.userId);
    await queueCompletedFileUpload(testContext.db, fencedUpload.id, fencedUpload.userId, {
      importJobId: `file-import-${fencedUpload.id}`,
      objectSizeBytes: fencedUpload.expectedSizeBytes,
    });
    await createFileUpload(testContext.db, visibleUpload);
    await markFileUploadUploading(
      testContext.db,
      visibleUpload.id,
      visibleUpload.userId,
      "visible-multipart",
    );
    await markFileUploadObjectUploaded(testContext.db, visibleUpload.id, visibleUpload.userId);
    await queueCompletedFileUpload(testContext.db, visibleUpload.id, visibleUpload.userId, {
      importJobId: `file-import-${visibleUpload.id}`,
      objectSizeBytes: visibleUpload.expectedSizeBytes,
    });
    await testContext.db.execute(
      sql`INSERT INTO fitness.account_erasure_request (
            id,
            user_id,
            user_hash,
            user_hash_key_id,
            write_fence_hash,
            status_token_hash,
            replay_retained_until,
            completion_deadline
          )
          VALUES (
            ${randomUUID()}::uuid,
            ${fencedUpload.userId}::uuid,
            ${"d".repeat(64)},
            'test-key',
            ${"e".repeat(64)},
            ${"f".repeat(64)},
            now() + interval '7 days',
            now() + interval '30 days'
          )`,
    );

    const requests = await listPendingFileUploadOutboxRequests(testContext.db, 100);

    expect(requests.map((request) => request.uploadId)).not.toContain(fencedUpload.id);
    expect(requests.map((request) => request.uploadId)).toContain(visibleUpload.id);
  });
});
