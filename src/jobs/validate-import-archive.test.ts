import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateImportArchive } from "./validate-import-archive.ts";

const temporaryDirectories: string[] = [];

async function zipBuffer(entryName: string): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  archive.pipe(output);
  archive.append("health-data", { name: entryName });
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.once("end", () => resolve(Buffer.concat(chunks)));
    output.once("error", reject);
    archive.once("error", reject);
  });
  await archive.finalize();
  return completed;
}

async function temporaryFile(contents: Buffer | string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-validation-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "upload.zip");
  await writeFile(filePath, contents);
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("validateImportArchive", () => {
  it("accepts a structurally valid ZIP", async () => {
    await expect(
      validateImportArchive(await temporaryFile(await zipBuffer("export/data.xml"))),
    ).resolves.toBeUndefined();
  });

  it("rejects content without a ZIP signature", async () => {
    await expect(validateImportArchive(await temporaryFile("not-a-zip"))).rejects.toThrow(
      "valid ZIP file signature",
    );
  });

  it("rejects traversal entry paths", async () => {
    const archive = await zipBuffer("safe.txt");
    const unsafeArchive = Buffer.from(archive);
    for (let offset = 0; offset < unsafeArchive.length - 8; offset++) {
      if (unsafeArchive.subarray(offset, offset + 8).toString() === "safe.txt") {
        unsafeArchive.write("../a.txt", offset, "utf8");
      }
    }
    await expect(validateImportArchive(await temporaryFile(unsafeArchive))).rejects.toThrow();
  });

  it("enforces ZIP signatures, expanded size, safe paths, and parser errors", async () => {
    async function validateWithMocks(input: {
      signature?: readonly number[];
      entries?: Array<{ fileName: string; uncompressedSize: number }>;
      openError?: Error;
      omitZipFile?: boolean;
      parserError?: Error;
    }): Promise<void> {
      vi.resetModules();
      const signature = input.signature ?? [0x50, 0x4b, 0x03, 0x04];
      const closeFile = vi.fn(async () => undefined);
      vi.doMock("node:fs/promises", async (importOriginal) => ({
        ...(await importOriginal()),
        open: vi.fn(async () => ({
          close: closeFile,
          read: vi.fn(async (buffer: Buffer) => {
            buffer.set(signature);
            return { bytesRead: signature.length };
          }),
        })),
      }));

      class FakeZipFile extends EventEmitter {
        readonly close = vi.fn();
        #entries = [...(input.entries ?? [])];

        readEntry(): void {
          queueMicrotask(() => {
            if (input.parserError) {
              this.emit("error", input.parserError);
              return;
            }
            const entry = this.#entries.shift();
            if (entry) this.emit("entry", entry);
            else this.emit("end");
          });
        }
      }

      const zipFile = new FakeZipFile();
      vi.doMock("yauzl", () => ({
        default: {
          open: vi.fn(
            (
              _filePath: string,
              options: { lazyEntries: boolean; validateEntrySizes: boolean },
              callback: (error: Error | null, openedZip?: FakeZipFile) => void,
            ) => {
              expect(options).toEqual({ lazyEntries: true, validateEntrySizes: true });
              callback(input.openError ?? null, input.omitZipFile ? undefined : zipFile);
            },
          ),
        },
      }));

      const freshModule = await import("./validate-import-archive.ts");
      const hasValidSignature =
        signature.length === 4 &&
        signature[0] === 0x50 &&
        signature[1] === 0x4b &&
        ((signature[2] === 0x03 && signature[3] === 0x04) ||
          (signature[2] === 0x05 && signature[3] === 0x06) ||
          (signature[2] === 0x07 && signature[3] === 0x08));
      try {
        await freshModule.validateImportArchive("upload.zip");
      } finally {
        expect(closeFile).toHaveBeenCalledOnce();
        if (hasValidSignature && !input.openError && !input.omitZipFile) {
          expect(zipFile.close).toHaveBeenCalledOnce();
        }
      }
    }

    await expect(
      validateWithMocks({ signature: [0x50, 0x4b, 0x05, 0x06] }),
    ).resolves.toBeUndefined();
    await expect(
      validateWithMocks({ signature: [0x50, 0x4b, 0x07, 0x08] }),
    ).resolves.toBeUndefined();
    await expect(validateWithMocks({ signature: [0x50, 0x4b, 0x03] })).rejects.toThrow(
      "valid ZIP file signature",
    );
    await expect(validateWithMocks({ signature: [0x51, 0x4b, 0x03, 0x04] })).rejects.toThrow(
      "valid ZIP file signature",
    );
    await expect(
      validateWithMocks({ openError: new Error("central directory invalid") }),
    ).rejects.toThrow("central directory invalid");
    await expect(validateWithMocks({ omitZipFile: true })).rejects.toThrow(
      "ZIP archive could not be opened",
    );
    await expect(
      validateWithMocks({
        entries: [{ fileName: "large.bin", uncompressedSize: 4 * 1024 * 1024 * 1024 + 1 }],
      }),
    ).rejects.toThrow("maximum expanded size");
    for (const unsafePath of ["/absolute/file", "C:/windows/file", "..", "../escape/file"]) {
      await expect(
        validateWithMocks({ entries: [{ fileName: unsafePath, uncompressedSize: 1 }] }),
      ).rejects.toThrow("unsafe entry path");
    }
    await expect(validateWithMocks({ parserError: new Error("parser failed") })).rejects.toThrow(
      "parser failed",
    );

    vi.doUnmock("node:fs/promises");
    vi.doUnmock("yauzl");
  });
});
