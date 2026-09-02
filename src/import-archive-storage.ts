import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ImportJobData } from "./jobs/queues.ts";

interface R2Config {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  secretAccessKey: string;
}

export interface ImportArchiveInput {
  contentType: string;
  extension: string;
  importType: ImportJobData["importType"];
  userId: string;
}

export interface ImportArchiveResult {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function readR2Config(): R2Config {
  return {
    accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    bucket: requiredEnv("IMPORT_R2_BUCKET"),
    endpoint: requiredEnv("R2_ENDPOINT"),
    secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
  };
}

function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    endpoint: config.endpoint,
    region: "auto",
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function buildImportArchiveObjectKey(input: ImportArchiveInput, sha256: string): string {
  return `imports/v1/${input.userId}/${input.importType}/${sha256}${input.extension}`;
}

/** Archive the original upload before parsing so imports can be replayed exactly. */
export async function archiveImportFileToR2(
  filePath: string,
  input: ImportArchiveInput,
): Promise<ImportArchiveResult> {
  const config = readR2Config();
  const [sha256, fileStats] = await Promise.all([sha256File(filePath), stat(filePath)]);
  const objectKey = buildImportArchiveObjectKey(input, sha256);
  const client = createR2Client(config);

  await client.send(
    new PutObjectCommand({
      Body: createReadStream(filePath),
      Bucket: config.bucket,
      ContentType: input.contentType,
      Key: objectKey,
      Metadata: { importtype: input.importType, sha256, userid: input.userId },
    }),
  );

  return { objectKey, sha256, sizeBytes: fileStats.size };
}
