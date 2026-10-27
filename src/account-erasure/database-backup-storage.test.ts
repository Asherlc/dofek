import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { R2DatabaseBackupStorage } from "./database-backup-storage.ts";

function makeStorage() {
  const client = new S3Client({ region: "us-east-1" });
  const send = vi.fn();
  Object.defineProperty(client, "send", { value: send });
  return { send, storage: new R2DatabaseBackupStorage(client, "backups") };
}

describe("R2DatabaseBackupStorage", () => {
  it("returns object and multipart continuation markers with their listed records", async () => {
    const { send, storage } = makeStorage();
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "Health-20260701.sql.gz" }],
        NextContinuationToken: "next-object-page",
      })
      .mockResolvedValueOnce({
        NextKeyMarker: "next-key",
        NextUploadIdMarker: "next-upload",
        Uploads: [{ Key: "Health-20260701.sql.gz", UploadId: "upload-1" }],
      });

    await expect(storage.listPage("current-object-page")).resolves.toEqual({
      nextContinuationToken: "next-object-page",
      objects: [{ key: "Health-20260701.sql.gz" }],
    });
    await expect(storage.listMultipartUploads("current-key", "current-upload")).resolves.toEqual({
      nextKeyMarker: "next-key",
      nextUploadIdMarker: "next-upload",
      uploads: [{ key: "Health-20260701.sql.gz", uploadId: "upload-1" }],
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a truncated listing omits the required continuation markers", async () => {
    const { send, storage } = makeStorage();
    send.mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: undefined });

    await expect(storage.listPage()).rejects.toThrow(
      "R2 database backup listing was truncated without a continuation token",
    );

    send.mockResolvedValueOnce({
      IsTruncated: true,
      NextKeyMarker: "next-key",
      NextUploadIdMarker: undefined,
    });
    await expect(storage.listMultipartUploads()).rejects.toThrow(
      "R2 database backup multipart listing was truncated without continuation markers",
    );
  });

  it("treats an already-aborted upload as idempotent but surfaces other abort failures", async () => {
    const { send, storage } = makeStorage();
    const absentUpload = new Error("upload is gone");
    absentUpload.name = "NoSuchUpload";
    send.mockRejectedValueOnce(absentUpload);

    await expect(
      storage.abortMultipartUpload("Health-20260701.sql.gz", "upload-1"),
    ).resolves.toBeUndefined();

    const unavailable = new Error("storage unavailable");
    send.mockRejectedValueOnce(unavailable);
    await expect(storage.abortMultipartUpload("Health-20260701.sql.gz", "upload-1")).rejects.toBe(
      unavailable,
    );
  });

  it("normalizes missing deletion error fields while retaining reported errors", async () => {
    const { send, storage } = makeStorage();
    send.mockResolvedValue({
      Errors: [
        { Code: undefined, Key: undefined },
        { Code: "AccessDenied", Key: "old-backup" },
      ],
    });

    await expect(storage.deleteObjects(["first", "second"])).resolves.toEqual({
      errors: [
        { code: "Unknown", key: "<unknown-key>" },
        { code: "AccessDenied", key: "old-backup" },
      ],
    });
  });
});
