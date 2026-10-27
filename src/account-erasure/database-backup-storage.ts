import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import type {
  BackupMultipartUploadPage,
  BackupObjectPage,
  DatabaseBackupStorage,
} from "./backup-retention.ts";

const MAX_DELETE_BATCH_SIZE = 1_000;

function isMissingMultipartUpload(error: unknown): boolean {
  return error instanceof Error && error.name === "NoSuchUpload";
}

export class R2DatabaseBackupStorage implements DatabaseBackupStorage {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async listPage(continuationToken?: string): Promise<BackupObjectPage> {
    const response = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        ContinuationToken: continuationToken,
        MaxKeys: MAX_DELETE_BATCH_SIZE,
      }),
    );
    if (response.IsTruncated && !response.NextContinuationToken) {
      throw new Error("R2 database backup listing was truncated without a continuation token");
    }
    return {
      ...(response.NextContinuationToken
        ? { nextContinuationToken: response.NextContinuationToken }
        : {}),
      objects: (response.Contents ?? []).map((object) => {
        if (!object.Key) {
          throw new Error("R2 database backup listing returned an object without a key");
        }
        return { key: object.Key };
      }),
    };
  }

  async listMultipartUploads(
    keyMarker?: string,
    uploadIdMarker?: string,
  ): Promise<BackupMultipartUploadPage> {
    const response = await this.#client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.#bucket,
        KeyMarker: keyMarker,
        MaxUploads: MAX_DELETE_BATCH_SIZE,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    if (response.IsTruncated && (!response.NextKeyMarker || !response.NextUploadIdMarker)) {
      throw new Error(
        "R2 database backup multipart listing was truncated without continuation markers",
      );
    }
    return {
      ...(response.NextKeyMarker ? { nextKeyMarker: response.NextKeyMarker } : {}),
      ...(response.NextUploadIdMarker ? { nextUploadIdMarker: response.NextUploadIdMarker } : {}),
      uploads: (response.Uploads ?? []).map((upload) => {
        if (!upload.Key || !upload.UploadId) {
          throw new Error(
            "R2 database backup multipart listing returned an upload without a key or upload ID",
          );
        }
        return { key: upload.Key, uploadId: upload.UploadId };
      }),
    };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.#client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!isMissingMultipartUpload(error)) throw error;
    }
  }

  async deleteObjects(
    keys: readonly string[],
  ): Promise<{ errors: readonly { code: string; key: string }[] }> {
    const response = await this.#client.send(
      new DeleteObjectsCommand({
        Bucket: this.#bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    return {
      errors: (response.Errors ?? []).map((error) => ({
        code: error.Code ?? "Unknown",
        key: error.Key ?? "<unknown-key>",
      })),
    };
  }
}
