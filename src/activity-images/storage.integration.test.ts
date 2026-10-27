import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSeaweedFsS3Container } from "../account-erasure/test-helpers.ts";
import { inspectImageBytes } from "./download.ts";
import {
  eraseActivityImageObjects,
  readActivityImageObject,
  storeActivityImage,
} from "./storage.ts";

describe("private activity originals against S3 storage", () => {
  let container: StartedTestContainer;
  let client: S3Client;
  let directory: string;
  const a = randomUUID(),
    b = randomUUID();
  const bucket = "activity-images-integration";
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
    "base64",
  );
  beforeAll(async () => {
    container = await createSeaweedFsS3Container({
      accessKeyId: "media",
      secretAccessKey: "media-secret",
    }).start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    client = new S3Client({
      endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: "media", secretAccessKey: "media-secret" },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    vi.stubEnv("R2_ENDPOINT", endpoint);
    vi.stubEnv("R2_ACCESS_KEY_ID", "media");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "media-secret");
    vi.stubEnv("ACTIVITY_MEDIA_R2_BUCKET", bucket);
    directory = await mkdtemp(join(tmpdir(), "media-integration-"));
    await writeFile(join(directory, "original"), bytes);
  }, 120000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    client?.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
    await container?.stop();
  });
  it("preserves original bytes, isolates owners and erases only the selected account", async () => {
    const image = {
      ...(await inspectImageBytes(bytes, "image/png")),
      filePath: join(directory, "original"),
      cleanup: async () => undefined,
    };
    const first = await storeActivityImage({ userId: a, image });
    expect(await storeActivityImage({ userId: a, image })).toEqual(first);
    const second = await storeActivityImage({ userId: b, image });
    expect(first.objectKey).not.toBe(second.objectKey);
    const stored = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: first.objectKey }),
    );
    expect(Buffer.from((await stored.Body?.transformToByteArray()) ?? [])).toEqual(bytes);
    expect(Buffer.from(await readActivityImageObject(first.objectKey))).toEqual(bytes);
    await eraseActivityImageObjects(a);
    await expect(
      client.send(new GetObjectCommand({ Bucket: bucket, Key: first.objectKey })),
    ).rejects.toThrow();
    expect(
      (await client.send(new GetObjectCommand({ Bucket: bucket, Key: second.objectKey })))
        .ContentLength,
    ).toBe(bytes.length);
  });
});
