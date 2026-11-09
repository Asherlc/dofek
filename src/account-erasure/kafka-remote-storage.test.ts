import type {
  ListMultipartUploadsCommandOutput,
  ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { KafkaRemoteStorage } from "./kafka-remote-storage.ts";

const boundary = {
  topic: "samples",
  topicId: "dI2O6HVWQkuC7XgSy7cJ3w",
  clusterId: "0000000000000000000000",
  partition: 0,
  low: "100",
  offset: "100",
};

function fixture(
  objects: Array<{ Key?: string }> = [],
  uploads: Array<{ Key?: string; UploadId?: string }> = [],
) {
  const send = vi.fn(
    async (
      command: {
        constructor: { name: string };
      },
      _options?: unknown,
    ): Promise<Partial<ListObjectsV2CommandOutput & ListMultipartUploadsCommandOutput>> =>
      command.constructor.name === "ListObjectsV2Command"
        ? { Contents: objects, IsTruncated: false }
        : { Uploads: uploads, IsTruncated: false },
  );
  const history = vi.fn(async () => new Map());
  const storage = new KafkaRemoteStorage({ send }, "bucket", "0000000000000000000000/", history);
  return { storage, send, history };
}

describe("stock tiered object verification", () => {
  it.each(["ListObjectsV2Command", "ListMultipartUploadsCommand"])(
    "aborts a stalled %s and fails verification",
    async (commandName) => {
      const { storage, send } = fixture();
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      send.mockImplementation(async (command, options) => {
        if (command.constructor.name !== commandName) return { IsTruncated: false };
        if (
          !options ||
          typeof options !== "object" ||
          !("abortSignal" in options) ||
          !(options.abortSignal instanceof AbortSignal)
        )
          throw new Error("missing request abort signal");
        const signal = options.abortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("listing aborted")), {
            once: true,
          });
        });
      });
      try {
        let failure: unknown;
        const result = storage.assertExpired([boundary]).then(
          () => {
            throw new Error("stalled listing unexpectedly passed");
          },
          (error: unknown) => {
            failure = error;
          },
        );
        await vi.waitFor(() =>
          expect(send).toHaveBeenCalledTimes(commandName === "ListObjectsV2Command" ? 1 : 2),
        );
        expect(timeout).toHaveBeenCalledWith(30_000);
        controller.abort();
        await result;
        expect(failure).toMatchObject({ message: "listing aborted" });
      } finally {
        timeout.mockRestore();
      }
    },
  );
  it("checks objects and multipart uploads after native terminal deletion", async () => {
    const { storage, send, history } = fixture();
    await expect(storage.assertExpired([boundary])).resolves.toEqual(new Map());
    expect(history).toHaveBeenCalledWith([boundary]);
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "ListObjectsV2Command",
      "ListMultipartUploadsCommand",
    ]);
  });
  it.each(["log", "indexes", "rsm-manifest"])(
    "blocks an expired %s object, including orphan attempts",
    async (suffix) => {
      const { storage } = fixture([
        {
          Key: `0000000000000000000000/samples-${boundary.topicId}/0/00000000000000000000-AAAAAAAAAAAAAAAAAAAAAQ.${suffix}`,
        },
      ]);
      await expect(storage.assertExpired([boundary])).rejects.toThrow("retains");
    },
  );
  it("blocks an admitted multipart upload for an expired segment", async () => {
    const { storage } = fixture(
      [],
      [
        {
          Key: `0000000000000000000000/samples-${boundary.topicId}/0/00000000000000000000-AAAAAAAAAAAAAAAAAAAAAQ.log`,
          UploadId: "pending",
        },
      ],
    );
    await expect(storage.assertExpired([boundary])).rejects.toThrow("retains");
  });
  it("allows newer native objects while rejecting unexplained generation or key layouts", async () => {
    const newer = `0000000000000000000000/samples-${boundary.topicId}/0/00000000000000000100-AAAAAAAAAAAAAAAAAAAAAQ.log`;
    await expect(fixture([{ Key: newer }]).storage.assertExpired([boundary])).resolves.toEqual(
      new Map(),
    );
    for (const key of [
      "0000000000000000000000/unknown",
      newer.replace(boundary.topicId, "AAAAAAAAAAAAAAAAAAAAAQ"),
      newer.replace("/0/", "/1/"),
    ]) {
      await expect(fixture([{ Key: key }]).storage.assertExpired([boundary])).rejects.toThrow(
        "Unknown",
      );
    }
  });
  it("fails closed on API errors, missing keys and incomplete pagination", async () => {
    const { storage, send } = fixture([{}]);
    await expect(storage.assertExpired([boundary])).rejects.toThrow();
    send.mockResolvedValue({ Contents: [], IsTruncated: true });
    await expect(storage.assertExpired([boundary])).rejects.toThrow("pagination");
    send.mockRejectedValue(new Error("denied"));
    await expect(storage.assertExpired([boundary])).rejects.toThrow("denied");
  });
  it("does not ignore native deletion failure even when object listing is empty", async () => {
    const { storage, history, send } = fixture();
    history.mockRejectedValue(new Error("copy/delete unfinished"));
    await expect(storage.assertExpired([boundary])).rejects.toThrow("unfinished");
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a response that omits the listing completeness flag", async () => {
    const { storage, send } = fixture();
    send.mockResolvedValueOnce({ Contents: [] });
    await expect(storage.assertExpired([boundary])).rejects.toThrow("pagination");
  });
  it("checks later object and multipart pages before reporting absence", async () => {
    const { storage, send } = fixture();
    const pending = {
      Key: `0000000000000000000000/samples-${boundary.topicId}/0/00000000000000000000-AAAAAAAAAAAAAAAAAAAAAQ.log`,
    };
    send.mockResolvedValueOnce({
      Contents: [],
      IsTruncated: true,
      NextContinuationToken: "second",
    });
    send.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    send.mockResolvedValueOnce({
      Uploads: [],
      IsTruncated: true,
      NextKeyMarker: "key",
      NextUploadIdMarker: "upload",
    });
    send.mockResolvedValueOnce({ Uploads: [pending], IsTruncated: false });
    await expect(storage.assertExpired([boundary])).rejects.toThrow("retains");
    expect(send).toHaveBeenCalledTimes(4);
  });
  it("rejects a retained object on the second object page", async () => {
    const { storage, send } = fixture();
    send.mockResolvedValueOnce({
      Contents: [],
      IsTruncated: true,
      NextContinuationToken: "second",
    });
    send.mockResolvedValueOnce({
      Contents: [
        {
          Key: `0000000000000000000000/samples-${boundary.topicId}/0/00000000000000000000-AAAAAAAAAAAAAAAAAAAAAQ.log`,
        },
      ],
      IsTruncated: false,
    });
    await expect(storage.assertExpired([boundary])).rejects.toThrow("retains");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rejects a repeated object continuation token", async () => {
    const { storage, send } = fixture();
    send.mockResolvedValue({ Contents: [], IsTruncated: true, NextContinuationToken: "same" });
    await expect(storage.assertExpired([boundary])).rejects.toThrow("pagination");
  });
  it("rejects a worker prefix from a different cluster", async () => {
    await expect(
      fixture().storage.assertExpired([{ ...boundary, clusterId: "AAAAAAAAAAAAAAAAAAAAAQ" }]),
    ).rejects.toThrow("prefix");
  });
  it("accepts a complete empty S3 listing with omitted arrays", async () => {
    const { storage, send } = fixture();
    send.mockResolvedValue({ IsTruncated: false });
    await expect(storage.assertExpired([boundary])).resolves.toEqual(new Map());
  });
  it("rejects repeated or incomplete multipart cursors", async () => {
    for (const page of [
      { IsTruncated: true },
      { IsTruncated: true, NextKeyMarker: "key" },
      { IsTruncated: true, NextKeyMarker: "key", NextUploadIdMarker: "upload" },
    ]) {
      const { storage, send } = fixture();
      send.mockResolvedValueOnce({ IsTruncated: false }).mockResolvedValue(page);
      await expect(storage.assertExpired([boundary])).rejects.toThrow("multipart pagination");
    }
  });
  it.each([
    ["", "prefix/"],
    ["bucket", "prefix"],
    ["bucket", "/prefix/"],
  ])("rejects an unqualified bucket/prefix pair", (bucket, prefix) => {
    expect(
      () => new KafkaRemoteStorage({ send: vi.fn() }, bucket, prefix, async () => new Map()),
    ).toThrow("required");
  });
});
