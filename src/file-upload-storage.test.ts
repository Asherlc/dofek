import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSignedUrl: vi.fn(),
  createR2Client: vi.fn(),
  requiredEnvironmentVariable: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.getSignedUrl }));
vi.mock("./r2-storage.ts", () => ({
  createR2Client: mocks.createR2Client,
  requiredR2EnvironmentVariable: mocks.requiredEnvironmentVariable,
}));

import { createImportUploadStorageFromEnv, R2ImportUploadStorage } from "./file-upload-storage.ts";

function clientWithResponses(...responses: unknown[]) {
  const client = new S3Client({
    region: "auto",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const send = vi.spyOn(client, "send");
  for (const response of responses) {
    Reflect.apply(send.mockResolvedValueOnce, send, [response]);
  }
  return { client, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSignedUrl.mockResolvedValue("https://upload.example/part");
});

describe("R2ImportUploadStorage", () => {
  it("creates multipart uploads with the configured bucket and content type", async () => {
    const { client, send } = clientWithResponses({ UploadId: "upload-1" });
    const storage = new R2ImportUploadStorage(client, "imports");

    await expect(storage.createMultipartUpload("user/source.zip", "application/zip")).resolves.toBe(
      "upload-1",
    );
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "imports",
      ContentType: "application/zip",
      Key: "user/source.zip",
    });
  });

  it("fails when multipart creation omits the upload ID", async () => {
    const { client } = clientWithResponses({});
    await expect(
      new R2ImportUploadStorage(client, "imports").createMultipartUpload("key", "text/csv"),
    ).rejects.toThrow("R2 did not return a multipart upload ID");
  });

  it("authorizes a bounded upload part with its exact content length", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    const { client } = clientWithResponses();
    const storage = new R2ImportUploadStorage(client, "imports");

    await expect(
      storage.authorizeUploadPart({
        objectKey: "key",
        multipartUploadId: "upload-1",
        partNumber: 3,
        contentLength: 512,
      }),
    ).resolves.toEqual({
      partNumber: 3,
      url: "https://upload.example/part",
      expiresAt: "2026-07-20T00:15:00.000Z",
    });
    expect(mocks.getSignedUrl.mock.calls[0]?.[1].input).toEqual({
      Bucket: "imports",
      ContentLength: 512,
      Key: "key",
      PartNumber: 3,
      UploadId: "upload-1",
    });
    expect(mocks.getSignedUrl).toHaveBeenCalledWith(client, expect.any(Object), { expiresIn: 900 });
    vi.useRealTimers();
  });

  it("lists every multipart page and maps complete part metadata", async () => {
    const { client, send } = clientWithResponses(
      {
        Parts: [{ PartNumber: 1, ETag: '"one"', Size: 5 }],
        IsTruncated: true,
        NextPartNumberMarker: "1",
      },
      { Parts: [{ PartNumber: 2, ETag: '"two"', Size: 7 }], IsTruncated: false },
    );

    await expect(
      new R2ImportUploadStorage(client, "imports").listParts("key", "upload-1"),
    ).resolves.toEqual([
      { partNumber: 1, etag: '"one"', sizeBytes: 5 },
      { partNumber: 2, etag: '"two"', sizeBytes: 7 },
    ]);
    expect(send.mock.calls[1]?.[0].input).toEqual({
      Bucket: "imports",
      Key: "key",
      PartNumberMarker: "1",
      UploadId: "upload-1",
    });
  });

  it.each([
    ["PartNumber", { ETag: '"etag"', Size: 1 }],
    ["ETag", { PartNumber: 1, Size: 1 }],
    ["Size", { PartNumber: 1, ETag: '"etag"' }],
  ])("rejects incomplete part metadata missing %s", async (_missingField, part) => {
    const { client } = clientWithResponses({ Parts: [part] });
    await expect(
      new R2ImportUploadStorage(client, "imports").listParts("key", "upload-1"),
    ).rejects.toThrow("R2 returned incomplete multipart part metadata");
  });

  it("rejects truncated part listings without a marker", async () => {
    const { client } = clientWithResponses({ IsTruncated: true });
    await expect(
      new R2ImportUploadStorage(client, "imports").listParts("key", "upload-1"),
    ).rejects.toThrow("R2 truncated ListParts without a continuation marker");
  });

  it("completes and aborts multipart uploads with exact identifiers", async () => {
    const { client, send } = clientWithResponses({}, {});
    const storage = new R2ImportUploadStorage(client, "imports");
    await storage.completeMultipartUpload("key", "upload-1", [
      { partNumber: 2, etag: '"two"' },
      { partNumber: 1, etag: '"one"' },
    ]);
    await storage.abortMultipartUpload("key", "upload-1");

    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "imports",
      Key: "key",
      MultipartUpload: {
        Parts: [
          { ETag: '"two"', PartNumber: 2 },
          { ETag: '"one"', PartNumber: 1 },
        ],
      },
      UploadId: "upload-1",
    });
    expect(send.mock.calls[1]?.[0].input).toEqual({
      Bucket: "imports",
      Key: "key",
      UploadId: "upload-1",
    });
  });

  it("heads, streams, and deletes objects", async () => {
    const body = Readable.from(["body"]);
    const { client, send } = clientWithResponses({ ContentLength: 4 }, { Body: body }, {});
    const storage = new R2ImportUploadStorage(client, "imports");

    await expect(storage.headObject("key")).resolves.toEqual({ sizeBytes: 4 });
    await expect(storage.getObjectStream("key")).resolves.toBe(body);
    await expect(storage.deleteObject("key")).resolves.toBeUndefined();
    expect(send.mock.calls.map((call) => call[0].input)).toEqual([
      { Bucket: "imports", Key: "key" },
      { Bucket: "imports", Key: "key" },
      { Bucket: "imports", Key: "key" },
    ]);
  });

  it("rejects unavailable object size and non-stream bodies", async () => {
    const { client } = clientWithResponses({}, { Body: new Uint8Array() });
    const storage = new R2ImportUploadStorage(client, "imports");

    await expect(storage.headObject("key")).rejects.toThrow("R2 object size is unavailable");
    await expect(storage.getObjectStream("key")).rejects.toThrow(
      "R2 object body is not a Node.js readable stream",
    );
  });

  it("lists valid objects across every page and ignores incomplete entries", async () => {
    const firstDate = new Date("2026-07-18T00:00:00Z");
    const secondDate = new Date("2026-07-19T00:00:00Z");
    const { client, send } = clientWithResponses(
      {
        Contents: [{ Key: "one", LastModified: firstDate }, { Key: "missing-date" }],
        IsTruncated: true,
        NextContinuationToken: "next",
      },
      { Contents: [{ Key: "two", LastModified: secondDate }, { LastModified: secondDate }] },
    );

    await expect(
      new R2ImportUploadStorage(client, "imports").listObjects("imports/"),
    ).resolves.toEqual([
      { objectKey: "one", lastModified: firstDate },
      { objectKey: "two", lastModified: secondDate },
    ]);
    expect(send.mock.calls[1]?.[0].input).toEqual({
      Bucket: "imports",
      Prefix: "imports/",
      ContinuationToken: "next",
    });
  });

  it("rejects truncated object listings without a token", async () => {
    const { client } = clientWithResponses({ IsTruncated: true });
    await expect(
      new R2ImportUploadStorage(client, "imports").listObjects("imports/"),
    ).rejects.toThrow("R2 truncated ListObjects without a continuation token");
  });
});

describe("createImportUploadStorageFromEnv", () => {
  it("uses the shared R2 client and required import bucket", () => {
    const { client } = clientWithResponses();
    mocks.createR2Client.mockReturnValue(client);
    mocks.requiredEnvironmentVariable.mockReturnValue("imports");

    expect(createImportUploadStorageFromEnv()).toBeInstanceOf(R2ImportUploadStorage);
    expect(mocks.createR2Client).toHaveBeenCalledOnce();
    expect(mocks.requiredEnvironmentVariable).toHaveBeenCalledWith("IMPORT_R2_BUCKET");
  });
});
