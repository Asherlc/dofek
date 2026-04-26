import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const EXPORT_FILENAME = "dofek-export.zip";

interface R2Config {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  secretAccessKey: string;
}

interface UploadExportInput {
  exportId: string;
  userId: string;
}

export interface UploadExportResult {
  objectKey: string;
  sizeBytes: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function readR2Config(): R2Config {
  return {
    accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    bucket: requiredEnv("EXPORT_R2_BUCKET"),
    endpoint: requiredEnv("R2_ENDPOINT"),
    secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
  };
}

function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    region: "auto",
  });
}

export function buildExportObjectKey(userId: string, exportId: string): string {
  return `exports/${userId}/${exportId}/${EXPORT_FILENAME}`;
}

export async function uploadExportFileToR2(
  filePath: string,
  input: UploadExportInput,
): Promise<UploadExportResult> {
  const config = readR2Config();
  const objectKey = buildExportObjectKey(input.userId, input.exportId);
  const fileStats = await stat(filePath);
  const client = createR2Client(config);

  await client.send(
    new PutObjectCommand({
      Body: createReadStream(filePath),
      Bucket: config.bucket,
      ContentType: "application/zip",
      Key: objectKey,
    }),
  );

  return { objectKey, sizeBytes: fileStats.size };
}

export async function createSignedExportDownloadUrl(objectKey: string): Promise<string> {
  const config = readR2Config();
  const client = createR2Client(config);
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
}
