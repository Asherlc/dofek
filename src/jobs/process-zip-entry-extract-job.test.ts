import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options as YauzlOptions, ZipFile } from "yauzl";
import yauzl from "yauzl";
import { processZipEntryExtractJob } from "./process-zip-entry-extract-job.ts";

const createdDirectories: string[] = [];
const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
type YauzlOpenCallback = (error: Error | null, zipFile: ZipFile) => void;

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zip-entry-extract-test-"));
  createdDirectories.push(directory);
  return directory;
}

async function createZip(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const finished = new Promise<Buffer>((resolve, reject) => {
    stream.on("close", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(stream);
  for (const [path, data] of Object.entries(entries)) {
    archive.append(data, { name: path });
  }
  await archive.finalize();
  return finished;
}

describe("processZipEntryExtractJob", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      createdDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("extracts a top-level ZIP entry to a filesystem path", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/activity.fit": "fit-bytes",
      }),
    );

    const result = await processZipEntryExtractJob({
      data: {
        userId: TEST_USER_ID,
        archivePath,
        entryPath: ["DI_CONNECT/activity.fit"],
        outputExtension: "fit",
      },
    });

    await expect(readFile(result.filePath, "utf8")).resolves.toBe("fit-bytes");
  });

  it("publishes output inside a parent-owned cleanup directory", async () => {
    const directory = await createTempDirectory();
    const outputDirectory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/activity.fit": "fit-bytes",
      }),
    );

    const result = await processZipEntryExtractJob({
      data: {
        userId: TEST_USER_ID,
        archivePath,
        entryPath: ["DI_CONNECT/activity.fit"],
        outputDirectory,
        outputExtension: "fit",
      },
    });

    expect(result.filePath.startsWith(`${outputDirectory}/`)).toBe(true);
    await expect(readFile(result.filePath, "utf8")).resolves.toBe("fit-bytes");
    const outputEntries = await readdir(outputDirectory);
    expect(
      outputEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });

  it("replaces an existing deterministic output path on replay", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/activity.fit": "first-fit-bytes",
      }),
    );

    const firstResult = await processZipEntryExtractJob({
      data: {
        userId: TEST_USER_ID,
        archivePath,
        entryPath: ["DI_CONNECT/activity.fit"],
        outputExtension: "fit",
      },
    });
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/activity.fit": "replayed-fit-bytes",
      }),
    );

    const replayResult = await processZipEntryExtractJob({
      data: {
        userId: TEST_USER_ID,
        archivePath,
        entryPath: ["DI_CONNECT/activity.fit"],
        outputExtension: "fit",
      },
    });

    expect(replayResult.filePath).toBe(firstResult.filePath);
    await expect(readFile(replayResult.filePath, "utf8")).resolves.toBe("replayed-fit-bytes");
  });

  it("preserves an existing deterministic output path when a replay extraction fails", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/activity.fit": "original-fit-bytes",
      }),
    );

    const firstResult = await processZipEntryExtractJob({
      data: {
        userId: TEST_USER_ID,
        archivePath,
        entryPath: ["DI_CONNECT/activity.fit"],
        outputExtension: "fit",
      },
    });
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/activity.fit": "oversized-replay-fit-bytes",
      }),
    );

    await expect(
      processZipEntryExtractJob({
        data: {
          userId: TEST_USER_ID,
          archivePath,
          entryPath: ["DI_CONNECT/activity.fit"],
          outputExtension: "fit",
          maxBytes: 3,
        },
      }),
    ).rejects.toThrow("ZIP entry DI_CONNECT/activity.fit exceeds maximum size of 3 bytes");

    await expect(readFile(firstResult.filePath, "utf8")).resolves.toBe("original-fit-bytes");
    const directoryEntries = await readdir(directory);
    expect(
      directoryEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });

  it("extracts an entry from a nested ZIP chain", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    const nestedZip = await createZip({
      "asher@example.com_12345.fit": "nested-fit-bytes",
    });
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip": nestedZip,
      }),
    );

    const result = await processZipEntryExtractJob({
      data: {
        userId: TEST_USER_ID,
        archivePath,
        entryPath: [
          "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
          "asher@example.com_12345.fit",
        ],
        outputExtension: "fit",
      },
    });

    await expect(readFile(result.filePath, "utf8")).resolves.toBe("nested-fit-bytes");
  });

  it("allows nested ZIP archives to be larger than the final extracted entry limit", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    const nestedZip = await createZip({
      "padding.txt": "padding that makes the nested archive larger than the final FIT limit",
      "asher@example.com_12345.fit": "fit",
    });
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip": nestedZip,
      }),
    );

    const result = await processZipEntryExtractJob({
      data: {
        userId: TEST_USER_ID,
        archivePath,
        entryPath: [
          "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
          "asher@example.com_12345.fit",
        ],
        outputExtension: "fit",
        maxBytes: 3,
        nestedArchiveMaxBytes: nestedZip.length,
      },
    });

    await expect(readFile(result.filePath, "utf8")).resolves.toBe("fit");
  });

  it("rejects final entries larger than the configured maxBytes and removes partial files", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/activity.fit": "fit-bytes",
      }),
    );

    await expect(
      processZipEntryExtractJob({
        data: {
          userId: TEST_USER_ID,
          archivePath,
          entryPath: ["DI_CONNECT/activity.fit"],
          outputExtension: "fit",
          maxBytes: 3,
        },
      }),
    ).rejects.toThrow("ZIP entry DI_CONNECT/activity.fit exceeds maximum size of 3 bytes");

    const directoryEntries = await readdir(directory);
    expect(directoryEntries.filter((entryName) => entryName.endsWith(".fit"))).toEqual([]);
    expect(
      directoryEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });

  it("rejects nested ZIP archives larger than the configured nested archive limit", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    const nestedZip = await createZip({
      "asher@example.com_12345.fit": "nested-fit-bytes",
    });
    await writeFile(
      archivePath,
      await createZip({
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip": nestedZip,
      }),
    );

    await expect(
      processZipEntryExtractJob({
        data: {
          userId: TEST_USER_ID,
          archivePath,
          entryPath: [
            "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
            "asher@example.com_12345.fit",
          ],
          outputExtension: "fit",
          maxBytes: 1024,
          nestedArchiveMaxBytes: 3,
        },
      }),
    ).rejects.toThrow(
      "ZIP entry DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip exceeds maximum size of 3 bytes",
    );

    const directoryEntries = await readdir(directory);
    expect(directoryEntries.filter((entryName) => entryName.endsWith(".fit"))).toEqual([]);
    expect(
      directoryEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });

  it("rejects malformed ZIP archives and removes the extraction temp directory", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(archivePath, "not a zip");

    await expect(
      processZipEntryExtractJob({
        data: {
          userId: TEST_USER_ID,
          archivePath,
          entryPath: ["DI_CONNECT/activity.fit"],
          outputExtension: "fit",
        },
      }),
    ).rejects.toThrow("End of central directory record signature not found");

    const directoryEntries = await readdir(directory);
    expect(
      directoryEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });

  it("rejects when the ZIP library returns no opened file", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(archivePath, await createZip({ "DI_CONNECT/activity.fit": "fit-bytes" }));
    function openWithoutZipFile(
      _filePath: string,
      _options: YauzlOptions,
      callback?: YauzlOpenCallback,
    ): void;
    function openWithoutZipFile(_filePath: string, callback?: YauzlOpenCallback): void;
    function openWithoutZipFile(
      _filePath: string,
      optionsOrCallback?: YauzlOptions | YauzlOpenCallback,
      callback?: YauzlOpenCallback,
    ): void {
      const openCallback = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      if (!openCallback) {
        throw new Error("Expected ZIP open callback");
      }
      Reflect.apply(openCallback, undefined, [null, undefined]);
    }
    vi.spyOn(yauzl, "open").mockImplementation(openWithoutZipFile);

    await expect(
      processZipEntryExtractJob({
        data: {
          userId: TEST_USER_ID,
          archivePath,
          entryPath: ["DI_CONNECT/activity.fit"],
          outputExtension: "fit",
        },
      }),
    ).rejects.toThrow(`ZIP file could not be opened: ${archivePath}`);

    const directoryEntries = await readdir(directory);
    expect(
      directoryEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });

  it("rejects missing entries", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(archivePath, await createZip({ "other.fit": "fit-bytes" }));

    await expect(
      processZipEntryExtractJob({
        data: {
          userId: TEST_USER_ID,
          archivePath,
          entryPath: ["missing.fit"],
          outputExtension: "fit",
        },
      }),
    ).rejects.toThrow("ZIP entry not found: missing.fit");

    const directoryEntries = await readdir(directory);
    expect(
      directoryEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });

  it("rejects empty ZIP entry path segments", async () => {
    const directory = await createTempDirectory();
    const archivePath = join(directory, "export.zip");
    await writeFile(archivePath, await createZip({ "DI_CONNECT/activity.fit": "fit-bytes" }));

    await expect(
      processZipEntryExtractJob({
        data: {
          userId: TEST_USER_ID,
          archivePath,
          entryPath: [""],
          outputExtension: "fit",
        },
      }),
    ).rejects.toThrow("ZIP entry path cannot be empty");

    const directoryEntries = await readdir(directory);
    expect(
      directoryEntries.filter((entryName) => entryName.startsWith(".zip-entry-extract-")),
    ).toEqual([]);
  });
});
