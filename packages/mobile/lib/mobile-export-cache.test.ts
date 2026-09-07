import { beforeEach, describe, expect, it, vi } from "vitest";

const fileSystemMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  deleteDirectory: vi.fn(),
  deleteFile: vi.fn(),
  directoryExists: true,
  fileExists: true,
}));

vi.mock("expo-file-system", () => ({
  Directory: class {
    readonly uri = "file:///cache/dofek-exports-v1";

    create = fileSystemMocks.createDirectory;
    delete = fileSystemMocks.deleteDirectory;

    get exists(): boolean {
      return fileSystemMocks.directoryExists;
    }
  },
  File: class {
    readonly uri: string;
    delete = fileSystemMocks.deleteFile;

    constructor(_directory: unknown, filename: string) {
      this.uri = `file:///cache/dofek-exports-v1/${filename}`;
    }

    get exists(): boolean {
      return fileSystemMocks.fileExists;
    }
  },
  Paths: {
    cache: { uri: "file:///cache" },
  },
}));

import {
  createMobileExportCacheFile,
  deleteMobileExportCacheFile,
  mobileExportCacheDirectoryUri,
  purgeMobileExportCache,
} from "./mobile-export-cache";

beforeEach(() => {
  vi.clearAllMocks();
  fileSystemMocks.directoryExists = true;
  fileSystemMocks.fileExists = true;
});

describe("mobile export cache", () => {
  it("creates an idempotent dedicated directory for account-owned export files", () => {
    const file = createMobileExportCacheFile("activity-12345678.fit");

    expect(fileSystemMocks.createDirectory).toHaveBeenCalledWith({
      idempotent: true,
      intermediates: true,
    });
    expect(file.uri).toBe("file:///cache/dofek-exports-v1/activity-12345678.fit");
    expect(mobileExportCacheDirectoryUri()).toBe("file:///cache/dofek-exports-v1/");
  });

  it.each(["", "../private.zip", "nested/private.zip", "private email.zip"])(
    "rejects unsafe export cache filename %j",
    (filename) => {
      expect(() => createMobileExportCacheFile(filename)).toThrow(
        "Export cache filename is invalid",
      );
    },
  );

  it("deletes the dedicated directory recursively when it exists", () => {
    purgeMobileExportCache();

    expect(fileSystemMocks.deleteDirectory).toHaveBeenCalledOnce();
  });

  it("treats an already-absent export cache as purged", () => {
    fileSystemMocks.directoryExists = false;

    purgeMobileExportCache();

    expect(fileSystemMocks.deleteDirectory).not.toHaveBeenCalled();
  });

  it("deletes one downloaded export idempotently after sharing", () => {
    const file = createMobileExportCacheFile("health-export.zip");

    deleteMobileExportCacheFile(file);

    expect(fileSystemMocks.deleteFile).toHaveBeenCalledOnce();
  });
});
