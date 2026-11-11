import { describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
vi.mock("../r2-storage.ts", () => ({
  createR2Client: () => ({ send, destroy }),
  requiredR2EnvironmentVariable: () => "private-media",
}));

import {
  activityImageObjectKey,
  eraseActivityImageObjects,
  readActivityImageObject,
} from "./storage.ts";

describe("activity image storage", () => {
  const a = "00000000-0000-4000-8000-000000000001",
    b = "00000000-0000-4000-8000-000000000002";
  it("shares identical files only within one account", () => {
    const hash = "a".repeat(64);
    expect(activityImageObjectKey(a, hash)).toBe(activityImageObjectKey(a, hash));
    expect(activityImageObjectKey(a, hash)).not.toBe(activityImageObjectKey(b, hash));
    expect(() => activityImageObjectKey("../escape", hash)).toThrow();
  });
  it("reads the selected original bytes and releases the storage client", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    send.mockReset().mockResolvedValue({ Body: { transformToByteArray: async () => bytes } });
    destroy.mockClear();
    expect(await readActivityImageObject("images/owner/original")).toEqual(bytes);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          Bucket: "private-media",
          Key: "images/owner/original",
        },
      }),
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("fails explicitly when an original has no body", async () => {
    send.mockReset().mockResolvedValue({});
    destroy.mockClear();
    await expect(readActivityImageObject("images/owner/original")).rejects.toThrow(
      "Activity image object has no body",
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("propagates original read failures and releases the storage client", async () => {
    send.mockReset().mockRejectedValue(new Error("R2 unavailable"));
    destroy.mockClear();
    await expect(readActivityImageObject("images/owner/original")).rejects.toThrow(
      "R2 unavailable",
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("paginates erasure and verifies the prefix is empty", async () => {
    send.mockReset();
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: `images/${a}/a` }],
        IsTruncated: true,
        NextContinuationToken: "next",
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [{ Key: `images/${a}/b` }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [] });
    await eraseActivityImageObjects(a);
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[2]?.[0].input.ContinuationToken).toBe("next");
  });
  it("propagates erasure failure rather than acknowledging deletion", async () => {
    send.mockReset().mockRejectedValue(new Error("R2 unavailable"));
    await expect(eraseActivityImageObjects(a)).rejects.toThrow("R2 unavailable");
  });
});

const signing = vi.hoisted(() => vi.fn(async () => "https://private.test/signed"));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: signing }));

it.each(["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)])(
  "rejects invalid storage hashes (%s)",
  (hash) =>
    expect(() => activityImageObjectKey("00000000-0000-4000-8000-000000000001", hash)).toThrow(),
);
it("uploads original bytes with their exact storage metadata and releases the client", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { storeActivityImage } = await import("./storage.ts");
  const dir = await mkdtemp(join(tmpdir(), "image-storage-"));
  const filePath = join(dir, "image");
  const bytes = Buffer.from("original image bytes");
  await writeFile(filePath, bytes);
  send.mockReset();
  destroy.mockClear();
  send.mockImplementationOnce(async (command) => {
    const chunks = [];
    for await (const chunk of command.input.Body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(command.input).toMatchObject({
      Bucket: "private-media",
      Key: `images/00000000-0000-4000-8000-000000000001/${"a".repeat(64)}`,
      ContentLength: bytes.length,
      ContentType: "image/png",
    });
  });
  try {
    expect(
      await storeActivityImage({
        userId: "00000000-0000-4000-8000-000000000001",
        image: {
          filePath,
          sha256: "a".repeat(64),
          sizeBytes: bytes.length,
          mimeType: "image/png",
          width: 1,
          height: 1,
          cleanup: async () => undefined,
        },
      }),
    ).toEqual({ objectKey: `images/00000000-0000-4000-8000-000000000001/${"a".repeat(64)}` });
    expect(destroy).toHaveBeenCalledOnce();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("signs a five-minute read URL and deletes only the selected object", async () => {
  const { createActivityImageUrl, deleteActivityImageObject } = await import("./storage.ts");
  destroy.mockClear();
  signing.mockClear();
  send.mockReset().mockResolvedValue({});
  expect(await createActivityImageUrl("images/owner/hash")).toBe("https://private.test/signed");
  expect(signing).toHaveBeenCalledWith(
    expect.objectContaining({ send }),
    expect.objectContaining({ input: { Bucket: "private-media", Key: "images/owner/hash" } }),
    { expiresIn: 300 },
  );
  await deleteActivityImageObject("images/owner/hash");
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ input: { Bucket: "private-media", Key: "images/owner/hash" } }),
  );
  expect(destroy).toHaveBeenCalledTimes(2);
});
it.each([{ Contents: [], IsTruncated: true }, { Contents: [{ Key: "leftover" }] }])(
  "does not acknowledge incomplete erasure listings",
  async (page) => {
    const user = "00000000-0000-4000-8000-000000000001";
    send.mockReset();
    destroy.mockClear();
    if (page.IsTruncated) send.mockResolvedValueOnce(page);
    else send.mockResolvedValueOnce({}).mockResolvedValueOnce(page);
    await expect(eraseActivityImageObjects(user)).rejects.toThrow(
      /Incomplete media deletion listing|Activity media deletion incomplete/,
    );
    expect(destroy).toHaveBeenCalledOnce();
  },
);
it("scopes empty erasure listings and skips entries without object keys", async () => {
  const user = "00000000-0000-4000-8000-000000000001";
  send
    .mockReset()
    .mockResolvedValueOnce({ Contents: [{}], IsTruncated: false, NextContinuationToken: "ignored" })
    .mockResolvedValueOnce({});
  await eraseActivityImageObjects(user);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]?.[0].input).toEqual({
    Bucket: "private-media",
    Prefix: `images/${user}/`,
    ContinuationToken: undefined,
  });
  expect(send.mock.calls[1]?.[0].input).toEqual({
    Bucket: "private-media",
    Prefix: `images/${user}/`,
    MaxKeys: 1,
  });
});
