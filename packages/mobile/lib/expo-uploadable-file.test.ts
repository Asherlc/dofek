import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createUploadTask: vi.fn(),
  open: vi.fn(),
  readBytes: vi.fn(),
  uploadAsync: vi.fn(),
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
    createUploadTask(...args: unknown[]) {
      mocks.createUploadTask(...args);
      return { uploadAsync: mocks.uploadAsync };
    }
  },
  FileMode: { ReadOnly: "r" },
  Paths: { cache: { uri: "file:///cache" } },
}));

import { createExpoUploadableMobileFile } from "./expo-uploadable-file";

describe("createExpoUploadableMobileFile", () => {
  it("reads only the requested shared-file header bytes", async () => {
    mocks.readBytes.mockReturnValue(new TextEncoder().encode("Date"));
    const file = createExpoUploadableMobileFile("file:///tmp/Strong%20Export.csv");

    await expect(file.readHeader(4)).resolves.toBe("Date");

    expect(mocks.open).toHaveBeenCalledWith("r");
    expect(mocks.readBytes).toHaveBeenCalledWith(4);
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
});
