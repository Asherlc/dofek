import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ZodType } from "zod";
import { z } from "zod";
import { logger } from "../logger.ts";

const r2ConfigSchema = z.object({
  R2_ENDPOINT: z.string().url(),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
});

export type R2Config = z.infer<typeof r2ConfigSchema>;

export function parseR2Config(env: Record<string, string | undefined>): R2Config {
  return r2ConfigSchema.parse(env);
}

export function createS3Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });
}

export interface R2Client {
  uploadBuffer(key: string, data: Buffer, contentType: string): Promise<void>;
  downloadBuffer(key: string): Promise<Buffer>;
  uploadJson(key: string, data: unknown): Promise<void>;
  downloadJson<T>(key: string, schema: ZodType<T>): Promise<T>;
}

export function createR2Client(s3Client: S3Client, bucket: string): R2Client {
  return {
    async uploadBuffer(key: string, data: Buffer, contentType: string): Promise<void> {
      logger.info(`Uploading ${data.length} bytes to r2://${bucket}/${key}`);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );
      logger.info(`Uploaded r2://${bucket}/${key}`);
    },

    async downloadBuffer(key: string): Promise<Buffer> {
      logger.info(`Downloading r2://${bucket}/${key}`);
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      if (!response.Body) {
        throw new Error(`Empty response body for r2://${bucket}/${key}`);
      }
      const bytes = await response.Body.transformToByteArray();
      logger.info(`Downloaded ${bytes.length} bytes from r2://${bucket}/${key}`);
      return Buffer.from(bytes);
    },

    async uploadJson(key: string, data: unknown): Promise<void> {
      const json = JSON.stringify(data);
      const buffer = Buffer.from(json, "utf-8");
      await this.uploadBuffer(key, buffer, "application/json");
    },

    async downloadJson<T>(key: string, schema: ZodType<T>): Promise<T> {
      const buffer = await this.downloadBuffer(key);
      const parsed: unknown = JSON.parse(buffer.toString("utf-8"));
      return schema.parse(parsed);
    },
  };
}

export function createR2ClientFromEnv(): R2Client {
  const config = parseR2Config(process.env);
  const s3Client = createS3Client(config);
  return createR2Client(s3Client, config.R2_BUCKET);
}
