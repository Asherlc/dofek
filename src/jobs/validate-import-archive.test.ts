import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import { validateImportArchive } from "./validate-import-archive.ts";

const temporaryDirectories: string[] = [];

async function zipBuffer(entryName: string): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 1 } });
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
});
