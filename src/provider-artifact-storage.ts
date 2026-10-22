import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { z } from "zod";
import { captureException } from "./lib/error-reporting.ts";
import { createR2Client, requiredR2EnvironmentVariable } from "./r2-storage.ts";

const segmentSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Invalid provider artifact ownership");
const identitySchema = z.object({
  userId: segmentSchema,
  providerId: segmentSchema,
  artifactId: z.string().regex(/^[a-f0-9]{64}$/, "Invalid provider artifact identifier"),
});
const objectKeySchema = z
  .string()
  .regex(
    /^provider-artifacts\/[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*\/[a-f0-9]{64}\.fit$/,
    "Invalid provider artifact object key",
  );

export interface ProviderArtifactStorage {
  ensureArtifact(input: {
    userId: string;
    providerId: string;
    artifactId: string;
    download: () => Promise<Readable>;
  }): Promise<string>;
  materializeArtifact(objectKey: string, filePath: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
  deleteForProvider(userId: string, providerId: string): Promise<void>;
}

export class R2ProviderArtifactStorage implements ProviderArtifactStorage {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async ensureArtifact(
    input: Parameters<ProviderArtifactStorage["ensureArtifact"]>[0],
  ): Promise<string> {
    const identity = identitySchema.parse(input);
    const objectKey = `provider-artifacts/${identity.userId}/${identity.providerId}/${identity.artifactId}.fit`;
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
      return objectKey;
    } catch (error: unknown) {
      if (
        !(error instanceof S3ServiceException) ||
        (error.$metadata.httpStatusCode !== 404 &&
          error.name !== "NoSuchKey" &&
          error.name !== "NotFound")
      ) {
        captureException(error, { tags: { operation: "provider-artifact-head" } });
        throw error;
      }
    }

    const body = await input.download();
    try {
      await new Upload({
        client: this.#client,
        params: {
          Bucket: this.#bucket,
          Key: objectKey,
          Body: body,
          ContentType: "application/octet-stream",
        },
      }).done();
    } finally {
      body.destroy();
    }
    return objectKey;
  }

  async materializeArtifact(objectKey: string, filePath: string): Promise<void> {
    objectKeySchema.parse(objectKey);
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    if (!(response.Body instanceof Readable)) {
      throw new Error("R2 provider artifact body is not a Node.js readable stream");
    }
    await pipeline(response.Body, createWriteStream(filePath));
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.#deletePrefix(`provider-artifacts/${segmentSchema.parse(userId)}/`);
  }

  async deleteForProvider(userId: string, providerId: string): Promise<void> {
    await this.#deletePrefix(
      `provider-artifacts/${segmentSchema.parse(userId)}/${segmentSchema.parse(providerId)}/`,
    );
  }

  async #deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (response.Contents ?? []).map((object) => {
        if (!object.Key?.startsWith(prefix)) {
          throw new Error("R2 returned a provider artifact outside its ownership prefix");
        }
        return { Key: objectKeySchema.parse(object.Key) };
      });
      if (objects.length > 0) {
        const deletion = await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (deletion.Errors?.length) {
          throw new Error("R2 failed to delete provider artifacts");
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      if (response.IsTruncated && !continuationToken) {
        throw new Error("R2 truncated provider artifact listing without a continuation token");
      }
    } while (continuationToken);
  }
}

export function createProviderArtifactStorageFromEnv(): ProviderArtifactStorage {
  return new R2ProviderArtifactStorage(
    createR2Client(),
    requiredR2EnvironmentVariable("IMPORT_R2_BUCKET"),
  );
}
