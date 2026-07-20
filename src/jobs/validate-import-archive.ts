import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import yauzl from "yauzl";

const MAX_ARCHIVE_ENTRY_COUNT = 100_000;
const MAX_ARCHIVE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error("ZIP archive could not be opened"));
        return;
      }
      resolve(zipFile);
    });
  });
}

function isUnsafeEntryPath(entryPath: string): boolean {
  const normalizedPath = normalize(entryPath.replaceAll("\\", "/"));
  return (
    isAbsolute(normalizedPath) ||
    /^[a-zA-Z]:/.test(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  );
}

async function verifyZipSignature(filePath: string): Promise<void> {
  const file = await open(filePath, "r");
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    const validSignature =
      bytesRead === 4 &&
      signature[0] === 0x50 &&
      signature[1] === 0x4b &&
      ((signature[2] === 0x03 && signature[3] === 0x04) ||
        (signature[2] === 0x05 && signature[3] === 0x06) ||
        (signature[2] === 0x07 && signature[3] === 0x08));
    if (!validSignature) throw new Error("Upload does not have a valid ZIP file signature");
  } finally {
    await file.close();
  }
}

export async function validateImportArchive(filePath: string): Promise<void> {
  await verifyZipSignature(filePath);
  const zipFile = await openZip(filePath);
  await new Promise<void>((resolve, reject) => {
    let entryCount = 0;
    let expandedBytes = 0;
    const fail = (error: Error) => {
      zipFile.close();
      reject(error);
    };
    zipFile.on("entry", (entry) => {
      entryCount++;
      expandedBytes += entry.uncompressedSize;
      if (entryCount > MAX_ARCHIVE_ENTRY_COUNT) {
        fail(new Error(`ZIP archive exceeds ${MAX_ARCHIVE_ENTRY_COUNT} entries`));
        return;
      }
      if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
        fail(new Error("ZIP archive exceeds the maximum expanded size"));
        return;
      }
      if (isUnsafeEntryPath(entry.fileName)) {
        fail(new Error("ZIP archive contains an unsafe entry path"));
        return;
      }
      zipFile.readEntry();
    });
    zipFile.once("end", () => {
      zipFile.close();
      resolve();
    });
    zipFile.once("error", fail);
    zipFile.readEntry();
  });
}
