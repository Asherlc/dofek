import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  create: vi.fn(),
  createUploadTask: vi.fn(),
  delete: vi.fn(),
  open: vi.fn(),
  readBytes: vi.fn(),
  uploadAsync: vi.fn(),
  write: vi.fn(),
}));

vi.mock("expo-crypto", () => ({ randomUUID: () => "part-file-id" }));

vi.mock("expo-file-system", () => ({
  File: class MockFile {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return true;
    }
    get name() {
      return "Strong Export.csv";
    }
    get type() {
      return "text/csv";
    }
    get size() {
      return 8;
    }
    async text() {
      return "Date,Workout Name,Duration,Exercise Name";
    }
    open(...args: unknown[]) {
      mocks.open(...args);
      return { close: mocks.close, readBytes: mocks.readBytes };
    }
    create() {
      mocks.create();
    }
    delete() {
      mocks.delete();
    }
    write(bytes: Uint8Array) {
      return mocks.write(bytes);
    }
    createUploadTask(...args: unknown[]) {
      mocks.createUploadTask(...args);
      return { uploadAsync: mocks.uploadAsync };
    }
  },
  FileMode: { ReadOnly: "r" },
  Paths: { cache: { uri: "file:///cache" } },
}));

import { createExpoUploadableMobileFile } from "./expo-uploadable-file";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createExpoUploadableMobileFile", () => {
  it("reads only the requested shared-file header bytes", async () => {
    mocks.readBytes.mockResolvedValue(new TextEncoder().encode("Date"));
    const file = createExpoUploadableMobileFile("file:///tmp/Strong%20Export.csv");

    await expect(file.readHeader(4)).resolves.toBe("Date");

    expect(mocks.open).toHaveBeenCalledWith("r");
    expect(mocks.readBytes).toHaveBeenCalledWith(4);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("hashes asynchronously read file bytes", async () => {
    mocks.readBytes.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const file = createExpoUploadableMobileFile("file:///tmp/Strong%20Export.csv");

    await expect(file.sha256()).resolves.toBe(
      "66840dda154e8a113c31dd0ad32f7f3a366a80e8136979d8f5a101d3d29d6f72",
    );

    expect(mocks.readBytes).toHaveBeenCalledWith(8);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("uploads a whole shared file through Expo's native upload task", async () => {
    mocks.uploadAsync.mockResolvedValue({ status: 200, headers: { etag: "part-etag" } });
    const file = createExpoUploadableMobileFile("file:///tmp/Strong%20Export.csv");

    await expect(
      file.uploadPart({
        url: "https://r2.example/part-1",
        offset: 0,
        length: 8,
        onProgress: vi.fn(),
      }),
    ).resolves.toEqual({ status: 200, headers: { etag: "part-etag" } });

    expect(mocks.createUploadTask).toHaveBeenCalledWith(
      "https://r2.example/part-1",
      expect.objectContaining({ httpMethod: "PUT", sessionType: "foreground" }),
    );
  });

  it("waits for an asynchronous multipart write before uploading the part file", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mocks.readBytes.mockResolvedValue(bytes);
    mocks.uploadAsync.mockResolvedValue({ status: 200, headers: { etag: "part-etag" } });
    let finishWrite = () => {};
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    mocks.write.mockReturnValueOnce(writeFinished);
    const file = createExpoUploadableMobileFile("file:///tmp/Strong%20Export.csv");

    const upload = file.uploadPart({
      url: "https://r2.example/part-1",
      offset: 4,
      length: 4,
      onProgress: vi.fn(),
    });

    await Promise.resolve();
    expect(mocks.write).toHaveBeenCalledWith(bytes);
    expect(mocks.createUploadTask).not.toHaveBeenCalled();
    finishWrite();
    await expect(upload).resolves.toEqual({ status: 200, headers: { etag: "part-etag" } });
    expect(mocks.write).toHaveBeenCalledWith(bytes);
    expect(mocks.delete).toHaveBeenCalledOnce();
  });
});
