import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { zipEntryExtractJobDataSchema } from "./queues.ts";

interface ZipEntryExtractJob {
  data: unknown;
}

export interface ZipEntryExtractJobResult {
  filePath: string;
}

const DEFAULT_MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;

function openZipFromPath(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new Error(`ZIP file could not be opened: ${filePath}`));
        return;
      }
      resolve(zipFile);
    });
  });
}

function openReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new Error(`ZIP entry could not be read: ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

function readNextZipEntry(zipFile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zipFile.off("entry", onEntry);
      zipFile.off("end", onEnd);
      zipFile.off("error", onError);
    };

    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

async function findZipEntry(
  zipPath: string,
  entryPath: string,
): Promise<{
  zipFile: yauzl.ZipFile;
  entry: yauzl.Entry;
}> {
  const zipFile = await openZipFromPath(zipPath);
  let found = false;
  try {
    while (true) {
      const entry = await readNextZipEntry(zipFile);
      if (!entry) {
        throw new Error(`ZIP entry not found: ${entryPath}`);
      }
      if (entry.fileName === entryPath) {
        found = true;
        return { zipFile, entry };
      }
    }
  } finally {
    if (!found) {
      zipFile.close();
    }
  }
}

async function streamToFile(
  stream: Readable,
  filePath: string,
  maxBytes: number,
  description: string,
): Promise<void> {
  let bytesRead = 0;
  await pipeline(
    stream,
    async function* limitBytes(source) {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.length;
        if (bytesRead > maxBytes) {
          throw new Error(`${description} exceeds maximum size of ${maxBytes} bytes`);
        }
        yield buffer;
      }
    },
    createWriteStream(filePath, { flags: "wx" }),
  );
}

async function extractEntryChain(
  archivePath: string,
  entryPath: string[],
  outputPath: string,
  maxBytes: number,
  nestedArchiveMaxBytes: number,
  tempDirectory: string,
): Promise<void> {
  const [headEntryPath, ...tailEntryPath] = entryPath;
  if (!headEntryPath) {
    throw new Error("ZIP entry path cannot be empty");
  }

  const { zipFile, entry } = await findZipEntry(archivePath, headEntryPath);
  try {
    const stream = await openReadStream(zipFile, entry);
    if (tailEntryPath.length === 0) {
      await streamToFile(stream, outputPath, maxBytes, `ZIP entry ${headEntryPath}`);
      return;
    }

    const nestedZipPath = join(
      tempDirectory,
      `${createHash("sha256").update(entryPath.join("\n")).digest("hex")}.zip`,
    );
    await streamToFile(stream, nestedZipPath, nestedArchiveMaxBytes, `ZIP entry ${headEntryPath}`);
    await extractEntryChain(
      nestedZipPath,
      tailEntryPath,
      outputPath,
      maxBytes,
      nestedArchiveMaxBytes,
      tempDirectory,
    );
  } finally {
    zipFile.close();
  }
}

export async function processZipEntryExtractJob(
  job: ZipEntryExtractJob,
): Promise<ZipEntryExtractJobResult> {
  const data = zipEntryExtractJobDataSchema.parse(job.data);
  const outputDirectory = data.outputDirectory ?? dirname(data.archivePath);
  const tempDirectory = await mkdtemp(join(outputDirectory, ".zip-entry-extract-"));
  const outputPath = join(
    outputDirectory,
    `${basename(data.archivePath)}-${createHash("sha256")
      .update(data.entryPath.join("\n"))
      .digest("hex")}.${data.outputExtension}`,
  );
  const publishPath = join(
    tempDirectory,
    `${createHash("sha256").update(`${outputPath}\n${Date.now()}`).digest("hex")}.${data.outputExtension}`,
  );

  let extracted = false;
  try {
    await extractEntryChain(
      data.archivePath,
      data.entryPath,
      publishPath,
      data.maxBytes ?? DEFAULT_MAX_EXTRACTED_BYTES,
      data.nestedArchiveMaxBytes ?? DEFAULT_MAX_EXTRACTED_BYTES,
      tempDirectory,
    );
    await rename(publishPath, outputPath);
    extracted = true;
  } finally {
    if (!extracted) {
      await rm(publishPath, { force: true });
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }

  return { filePath: outputPath };
}
