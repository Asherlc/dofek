import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryUploadStateStore, type UploadStatus } from "./upload-state-store.ts";

describe("InMemoryUploadStateStore", () => {
  let store: InMemoryUploadStateStore;

  beforeEach(() => {
    store = new InMemoryUploadStateStore();
  });

  it("stores upload sessions and received chunks", async () => {
    await store.saveUploadSession("upload-1", {
      total: 3,
      dir: "/tmp/upload-1",
      userId: "user-1",
    });

    await store.addReceivedChunk("upload-1", 2);
    await store.addReceivedChunk("upload-1", 0);

    expect(await store.getUploadSession("upload-1")).toEqual({
      total: 3,
      dir: "/tmp/upload-1",
      userId: "user-1",
    });
    expect(await store.getReceivedChunkCount("upload-1")).toBe(2);
    expect(await store.getReceivedChunks("upload-1")).toEqual([0, 2]);
  });

  it("stores and deletes upload statuses", async () => {
    const status: UploadStatus = {
      status: "uploading",
      progress: 50,
      message: "Receiving chunks...",
      userId: "user-1",
      expiresAt: Date.now() + 1000,
    };

    await store.saveUploadStatus("upload-2", status);
    expect(await store.getUploadStatus("upload-2")).toEqual(status);

    await store.deleteUploadStatus("upload-2");
    expect(await store.getUploadStatus("upload-2")).toBeNull();
  });
});
