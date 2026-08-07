import { Directory, File, Paths } from "expo-file-system";

const EXPORT_CACHE_DIRECTORY_NAME = "dofek-exports-v1";
const EXPORT_CACHE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function exportCacheDirectory(): Directory {
  return new Directory(Paths.cache, EXPORT_CACHE_DIRECTORY_NAME);
}

function ensureExportCacheDirectory(): Directory {
  const directory = exportCacheDirectory();
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export function createMobileExportCacheFile(filename: string): File {
  if (!EXPORT_CACHE_FILENAME_PATTERN.test(filename)) {
    throw new Error("Export cache filename is invalid");
  }
  return new File(ensureExportCacheDirectory(), filename);
}

export function mobileExportCacheDirectoryUri(): string {
  const uri = ensureExportCacheDirectory().uri;
  return uri.endsWith("/") ? uri : `${uri}/`;
}

export function deleteMobileExportCacheFile(file: File): void {
  if (file.exists) {
    file.delete();
  }
}

export function purgeMobileExportCache(): void {
  const directory = exportCacheDirectory();
  if (directory.exists) {
    directory.delete();
  }
}
