import { createReadStream } from "node:fs";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { createR2Client, requiredR2EnvironmentVariable } from "../r2-storage.ts";
import type { DownloadedImage } from "./download.ts";
export function activityImagePrefix(userId: string): string {
  return `images/${z.uuid().parse(userId)}/`;
}
export function activityImageObjectKey(userId: string, sha256: string): string {
  return `${activityImagePrefix(userId)}${z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(sha256)}`;
}
export async function storeActivityImage(input: {
  userId: string;
  image: DownloadedImage;
}): Promise<{ objectKey: string }> {
  const objectKey = activityImageObjectKey(input.userId, input.image.sha256);
  const client = createR2Client();
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: requiredR2EnvironmentVariable("ACTIVITY_MEDIA_R2_BUCKET"),
        Key: objectKey,
        Body: createReadStream(input.image.filePath),
        ContentLength: input.image.sizeBytes,
        ContentType: input.image.mimeType,
      }),
    );
    return { objectKey };
  } finally {
    client.destroy();
  }
}
export async function createActivityImageUrl(objectKey: string): Promise<string> {
  const client = createR2Client();
  try {
    return await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: requiredR2EnvironmentVariable("ACTIVITY_MEDIA_R2_BUCKET"),
        Key: objectKey,
      }),
      { expiresIn: 300 },
    );
  } finally {
    client.destroy();
  }
}
export async function readActivityImageObject(objectKey: string): Promise<Uint8Array> {
  const client = createR2Client();
  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: requiredR2EnvironmentVariable("ACTIVITY_MEDIA_R2_BUCKET"),
        Key: objectKey,
      }),
    );
    if (!result.Body) throw new Error("Activity image object has no body");
    return await result.Body.transformToByteArray();
  } finally {
    client.destroy();
  }
}
export async function deleteActivityImageObject(objectKey: string): Promise<void> {
  const client = createR2Client();
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: requiredR2EnvironmentVariable("ACTIVITY_MEDIA_R2_BUCKET"),
        Key: objectKey,
      }),
    );
  } finally {
    client.destroy();
  }
}
export async function eraseActivityImageObjects(userId: string): Promise<void> {
  const client = createR2Client();
  const bucket = requiredR2EnvironmentVariable("ACTIVITY_MEDIA_R2_BUCKET");
  const prefix = activityImagePrefix(userId);
  try {
    let cursor: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: cursor }),
      );
      for (const object of page.Contents ?? [])
        if (object.Key)
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      if (page.IsTruncated && !page.NextContinuationToken)
        throw Error("Incomplete media deletion listing");
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    const remaining = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }),
    );
    if (remaining.Contents?.length) throw Error("Activity media deletion incomplete");
  } finally {
    client.destroy();
  }
}
