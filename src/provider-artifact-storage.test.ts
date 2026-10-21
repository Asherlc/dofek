import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  createR2Client: vi.fn(),
  requiredEnvironmentVariable: vi.fn(),
}));

vi.mock("./lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));
vi.mock("./r2-storage.ts", () => ({
  createR2Client: mocks.createR2Client,
  requiredR2EnvironmentVariable: mocks.requiredEnvironmentVariable,
}));

import {
  createProviderArtifactStorageFromEnv,
  R2ProviderArtifactStorage,
} from "./provider-artifact-storage.ts";

const artifactId = "a".repeat(64);
const objectKey = `provider-artifacts/user-1/garmin/${artifactId}.fit`;

function clientWithResponses(...responses: unknown[]) {
  const client = new S3Client({
    endpoint: "https://r2.example.test",
    region: "auto",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const send = vi.spyOn(client, "send");
  for (const response of responses) Reflect.apply(send.mockResolvedValueOnce, send, [response]);
  return { client, send };
}

function serviceError(name: string, httpStatusCode?: number) {
  return new S3ServiceException({
    name,
    message: name,
    $fault: "client",
    $metadata: { httpStatusCode },
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("R2ProviderArtifactStorage", () => {
  it("reuses an archived artifact before invoking a one-use source download", async () => {
    const { client, send } = clientWithResponses({ ContentLength: 12 });
    const download = vi.fn(async () => Readable.from(["unused"]));

    await expect(
      new R2ProviderArtifactStorage(client, "imports").ensureArtifact({
        userId: "user-1",
        providerId: "garmin",
        artifactId,
        download,
      }),
    ).resolves.toBe(objectKey);
    expect(download).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: "imports", Key: objectKey });
  });

  it.each([
    ["NotFound", 404],
    ["NoSuchKey", undefined],
    ["UnknownError", 404],
  ])("archives a missing artifact after %s and reuses it on retry", async (name, status) => {
    const { client, send } = clientWithResponses();
    let archived: Uint8Array | undefined;
    send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        if (!archived) throw serviceError(name, status);
        return { ContentLength: archived.byteLength, $metadata: {} };
      }
      if (command instanceof PutObjectCommand && command.input.Body instanceof Uint8Array) {
        archived = command.input.Body;
        return { ETag: "stored", $metadata: {} };
      }
      throw new Error("Unexpected R2 command");
    });
    const download = vi.fn(async () => Readable.from([Buffer.from("FIT-"), Buffer.from("data")]));
    const storage = new R2ProviderArtifactStorage(client, "imports");
    const input = { userId: "user-1", providerId: "garmin", artifactId, download };

    await expect(storage.ensureArtifact(input)).resolves.toBe(objectKey);
    await expect(storage.ensureArtifact(input)).resolves.toBe(objectKey);

    expect(Buffer.from(archived ?? []).toString()).toBe("FIT-data");
    expect(download).toHaveBeenCalledOnce();
  });

  it.each([serviceError("AccessDenied", 403), new Error("R2 connection failed")])(
    "fails before using the download when archive availability cannot be checked",
    async (error) => {
      const { client, send } = clientWithResponses();
      send.mockRejectedValueOnce(error);
      const download = vi.fn(async () => Readable.from(["unused"]));

      await expect(
        new R2ProviderArtifactStorage(client, "imports").ensureArtifact({
          userId: "user-1",
          providerId: "garmin",
          artifactId,
          download,
        }),
      ).rejects.toThrow(error);
      expect(download).not.toHaveBeenCalled();
      expect(mocks.captureException).toHaveBeenCalledWith(error, expect.any(Object));
    },
  );

  it("propagates failed archive writes so parsing cannot start", async () => {
    const { client, send } = clientWithResponses();
    send.mockRejectedValueOnce(serviceError("NotFound", 404));
    send.mockRejectedValueOnce(new Error("R2 upload failed"));
    const stream = Readable.from(["FIT-data"]);

    await expect(
      new R2ProviderArtifactStorage(client, "imports").ensureArtifact({
        userId: "user-1",
        providerId: "garmin",
        artifactId,
        download: async () => stream,
      }),
    ).rejects.toThrow("R2 upload failed");
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    { userId: "../user-2", providerId: "garmin", artifactId },
    { userId: "user-1", providerId: "garmin/other", artifactId },
    { userId: "user-1", providerId: "garmin", artifactId: "callback?token=secret" },
  ])("rejects unsafe ownership and non-opaque artifact identifiers", async (identity) => {
    const { client, send } = clientWithResponses();
    const download = vi.fn(async () => Readable.from(["unused"]));

    await expect(
      new R2ProviderArtifactStorage(client, "imports").ensureArtifact({ ...identity, download }),
    ).rejects.toThrow("Invalid provider artifact");
    expect(send).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("streams archived content to the requested local file without deleting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-artifact-test-"));
    try {
      const { client, send } = clientWithResponses({ Body: Readable.from(["FIT-", "data"]) });
      const path = join(directory, "source.fit");

      await new R2ProviderArtifactStorage(client, "imports").materializeArtifact(objectKey, path);

      expect(await readFile(path, "utf8")).toBe("FIT-data");
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: "imports", Key: objectKey });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid materialization keys and missing response streams", async () => {
    const { client, send } = clientWithResponses({});
    const storage = new R2ProviderArtifactStorage(client, "imports");

    await expect(
      storage.materializeArtifact("imports/user-2/source.fit", "/unused"),
    ).rejects.toThrow("Invalid provider artifact object key");
    expect(send).not.toHaveBeenCalled();
    await expect(storage.materializeArtifact(objectKey, "/unused")).rejects.toThrow(
      "R2 provider artifact body is not a Node.js readable stream",
    );
  });

  it("deletes all provider pages within exactly one user/provider prefix", async () => {
    const secondKey = `provider-artifacts/user-1/garmin/${"b".repeat(64)}.fit`;
    const { client, send } = clientWithResponses(
      { Contents: [{ Key: objectKey }], IsTruncated: true, NextContinuationToken: "next" },
      {},
      { Contents: [{ Key: secondKey }], IsTruncated: false },
      {},
    );

    await new R2ProviderArtifactStorage(client, "imports").deleteForProvider("user-1", "garmin");

    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      {
        Bucket: "imports",
        Prefix: "provider-artifacts/user-1/garmin/",
        ContinuationToken: undefined,
      },
      { Bucket: "imports", Delete: { Objects: [{ Key: objectKey }], Quiet: true } },
      { Bucket: "imports", Prefix: "provider-artifacts/user-1/garmin/", ContinuationToken: "next" },
      { Bucket: "imports", Delete: { Objects: [{ Key: secondKey }], Quiet: true } },
    ]);
  });

  it("removes account artifacts for every provider under the owned user prefix", async () => {
    const otherKey = `provider-artifacts/user-1/other/${"b".repeat(64)}.fit`;
    const { client, send } = clientWithResponses(
      { Contents: [{ Key: objectKey }, { Key: otherKey }] },
      {},
    );

    await new R2ProviderArtifactStorage(client, "imports").deleteForUser("user-1");

    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Prefix: "provider-artifacts/user-1/" });
    const deletion = send.mock.calls[1]?.[0];
    expect(deletion).toBeInstanceOf(DeleteObjectsCommand);
    expect(deletion?.input).toMatchObject({
      Delete: { Objects: [{ Key: objectKey }, { Key: otherKey }] },
    });
  });

  it("fails closed on a foreign object returned by listing", async () => {
    const { client, send } = clientWithResponses({
      Contents: [{ Key: `provider-artifacts/user-2/garmin/${artifactId}.fit` }],
    });

    await expect(
      new R2ProviderArtifactStorage(client, "imports").deleteForProvider("user-1", "garmin"),
    ).rejects.toThrow("outside its ownership prefix");
    expect(send).toHaveBeenCalledOnce();
  });

  it("propagates partial deletion errors and malformed pagination", async () => {
    const { client } = clientWithResponses(
      { Contents: [{ Key: objectKey }] },
      { Errors: [{ Key: objectKey, Code: "AccessDenied" }] },
    );
    await expect(
      new R2ProviderArtifactStorage(client, "imports").deleteForUser("user-1"),
    ).rejects.toThrow("R2 failed to delete provider artifacts");
    const malformed = clientWithResponses({ Contents: [], IsTruncated: true });
    await expect(
      new R2ProviderArtifactStorage(malformed.client, "imports").deleteForUser("user-1"),
    ).rejects.toThrow("continuation token");
  });

  it("constructs storage using the existing import bucket and R2 configuration", async () => {
    const { client, send } = clientWithResponses({});
    mocks.createR2Client.mockReturnValue(client);
    mocks.requiredEnvironmentVariable.mockReturnValue("configured-imports");

    await createProviderArtifactStorageFromEnv().ensureArtifact({
      userId: "user-1",
      providerId: "garmin",
      artifactId,
      download: async () => Readable.from(["unused"]),
    });

    expect(mocks.requiredEnvironmentVariable).toHaveBeenCalledWith("IMPORT_R2_BUCKET");
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Bucket: "configured-imports" });
  });
});
