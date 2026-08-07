import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createR2Client, requiredR2EnvironmentVariable } from "./r2-storage.ts";

const PART_AUTHORIZATION_TTL_SECONDS = 15 * 60;

export interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface AuthorizedUploadPart {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface CompletedUploadPart {
  partNumber: number;
  etag: string;
}

export interface ImportUploadStorage {
  abortMultipartUpload(objectKey: string, multipartUploadId: string): Promise<void>;
  authorizeUploadPart(input: {
    objectKey: string;
    multipartUploadId: string;
    partNumber: number;
    contentLength: number;
  }): Promise<AuthorizedUploadPart>;
  completeMultipartUpload(
    objectKey: string,
    multipartUploadId: string,
    parts: readonly CompletedUploadPart[],
  ): Promise<void>;
  createMultipartUpload(objectKey: string, contentType: string): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
  getObjectStream(objectKey: string): Promise<Readable>;
  headObject(objectKey: string): Promise<{ sizeBytes: number }>;
  listParts(objectKey: string, multipartUploadId: string): Promise<UploadedPart[]>;
  listObjects(prefix: string): Promise<Array<{ objectKey: string; lastModified: Date }>>;
}

export class R2ImportUploadStorage implements ImportUploadStorage {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async createMultipartUpload(objectKey: string, contentType: string): Promise<string> {
    const response = await this.#client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        ContentType: contentType,
        Key: objectKey,
      }),
    );
    if (!response.UploadId) throw new Error("R2 did not return a multipart upload ID");
    return response.UploadId;
  }

  async authorizeUploadPart(input: {
    objectKey: string;
    multipartUploadId: string;
    partNumber: number;
    contentLength: number;
  }): Promise<AuthorizedUploadPart> {
    const expiresAt = new Date(Date.now() + PART_AUTHORIZATION_TTL_SECONDS * 1000).toISOString();
    const url = await getSignedUrl(
      this.#client,
      new UploadPartCommand({
        Bucket: this.#bucket,
        ContentLength: input.contentLength,
        Key: input.objectKey,
        PartNumber: input.partNumber,
        UploadId: input.multipartUploadId,
      }),
      { expiresIn: PART_AUTHORIZATION_TTL_SECONDS },
    );
    return { partNumber: input.partNumber, url, expiresAt };
  }

  async listParts(objectKey: string, multipartUploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;
    do {
      const response = await this.#client.send(
        new ListPartsCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          PartNumberMarker: partNumberMarker,
          UploadId: multipartUploadId,
        }),
      );
      for (const part of response.Parts ?? []) {
        if (part.PartNumber === undefined || !part.ETag || part.Size === undefined) {
          throw new Error("R2 returned incomplete multipart part metadata");
        }
        parts.push({ partNumber: part.PartNumber, etag: part.ETag, sizeBytes: part.Size });
      }
      partNumberMarker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
      if (response.IsTruncated && partNumberMarker === undefined) {
        throw new Error("R2 truncated ListParts without a continuation marker");
      }
    } while (partNumberMarker !== undefined);
    return parts;
  }

  async completeMultipartUpload(
    objectKey: string,
    multipartUploadId: string,
    parts: readonly CompletedUploadPart[],
  ): Promise<void> {
    await this.#client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        MultipartUpload: {
          Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
        },
        UploadId: multipartUploadId,
      }),
    );
  }

  async abortMultipartUpload(objectKey: string, multipartUploadId: string): Promise<void> {
    await this.#client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        UploadId: multipartUploadId,
      }),
    );
  }

  async headObject(objectKey: string): Promise<{ sizeBytes: number }> {
    const response = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    if (response.ContentLength === undefined) throw new Error("R2 object size is unavailable");
    return { sizeBytes: response.ContentLength };
  }

  async getObjectStream(objectKey: string): Promise<Readable> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    if (!response.Body || !("pipe" in response.Body)) {
      throw new Error("R2 object body is not a Node.js readable stream");
    }
    return response.Body;
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
  }

  async listObjects(prefix: string): Promise<Array<{ objectKey: string; lastModified: Date }>> {
    const objects: Array<{ objectKey: string; lastModified: Date }> = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key && object.LastModified) {
          objects.push({ objectKey: object.Key, lastModified: object.LastModified });
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      if (response.IsTruncated && !continuationToken) {
        throw new Error("R2 truncated ListObjects without a continuation token");
      }
    } while (continuationToken);
    return objects;
  }
}

export function createImportUploadStorageFromEnv(): ImportUploadStorage {
  return new R2ImportUploadStorage(
    createR2Client(),
    requiredR2EnvironmentVariable("IMPORT_R2_BUCKET"),
  );
}
