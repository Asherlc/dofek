import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createR2Client, readR2ClientConfig, requiredR2EnvironmentVariable } from "./r2-storage.ts";

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const EXPORT_FILENAME = "dofek-export.zip";

interface ExportR2Config {
  bucket: string;
}

interface UploadExportInput {
  exportId: string;
  userId: string;
}

export interface UploadExportResult {
  objectKey: string;
  sizeBytes: number;
}

function readExportR2Config(): ExportR2Config {
  return {
    bucket: requiredR2EnvironmentVariable("EXPORT_R2_BUCKET"),
  };
}

export function buildExportObjectKey(userId: string, exportId: string): string {
  return `exports/${userId}/${exportId}/${EXPORT_FILENAME}`;
}

export async function uploadExportFileToR2(
  filePath: string,
  input: UploadExportInput,
): Promise<UploadExportResult> {
  const config = readExportR2Config();
  const objectKey = buildExportObjectKey(input.userId, input.exportId);
  const fileStats = await stat(filePath);
  const client = createR2Client(readR2ClientConfig());

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
  const config = readExportR2Config();
  const client = createR2Client(readR2ClientConfig());
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
}
