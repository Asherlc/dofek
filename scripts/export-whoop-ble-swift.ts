import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const managedPaths = [
  "Package.swift",
  "LICENSE",
  "README.md",
  "ios",
  "Tests",
  "Documentation",
] as const;

function isWithin(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function requireFile(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Required export source is missing: ${path}`);
  }
}

function requireDirectory(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Required export source directory is missing: ${path}`);
  }
}

function copyExportToStage(
  sourceDirectory: string,
  protocolDocumentationPath: string,
  stageDirectory: string,
): void {
  cpSync(join(sourceDirectory, "Package.swift"), join(stageDirectory, "Package.swift"));
  cpSync(join(sourceDirectory, "LICENSE"), join(stageDirectory, "LICENSE"));
  cpSync(join(sourceDirectory, "README.swift.md"), join(stageDirectory, "README.md"));
  cpSync(join(sourceDirectory, "Tests"), join(stageDirectory, "Tests"), { recursive: true });

  const sourceIosDirectory = join(sourceDirectory, "ios");
  const stagedIosDirectory = join(stageDirectory, "ios");
  mkdirSync(stagedIosDirectory);
  for (const entry of readdirSync(sourceIosDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".swift") && entry.name !== "WhoopBleModule.swift") {
      cpSync(join(sourceIosDirectory, entry.name), join(stagedIosDirectory, entry.name));
    }
  }

  const documentationDirectory = join(stageDirectory, "Documentation");
  mkdirSync(documentationDirectory);
  cpSync(protocolDocumentationPath, join(documentationDirectory, "WHOOP-BLE-Protocol.md"));
}

function main(): void {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || arguments_[0]?.trim().length === 0) {
    throw new Error("Usage: pnpm tsx scripts/export-whoop-ble-swift.ts <target-directory>");
  }

  const workspaceDirectory = realpathSync(process.cwd());
  const sourceDirectory = realpathSync(
    join(workspaceDirectory, "packages/mobile/modules/whoop-ble"),
  );
  const requestedTarget = resolve(workspaceDirectory, arguments_[0]);

  if (!existsSync(requestedTarget) || !statSync(requestedTarget).isDirectory()) {
    throw new Error(`Target directory must already exist: ${requestedTarget}`);
  }

  const targetDirectory = realpathSync(requestedTarget);
  if (isWithin(targetDirectory, sourceDirectory) || isWithin(sourceDirectory, targetDirectory)) {
    throw new Error(
      `Refusing unsafe target that overlaps the WHOOP BLE source: ${targetDirectory}`,
    );
  }

  const readmePath = join(sourceDirectory, "README.swift.md");
  const protocolDocumentationPath = join(workspaceDirectory, "docs/whoop-ble-protocol.md");
  requireFile(join(sourceDirectory, "Package.swift"));
  requireFile(join(sourceDirectory, "LICENSE"));
  requireFile(readmePath);
  requireDirectory(join(sourceDirectory, "ios"));
  requireDirectory(join(sourceDirectory, "Tests"));
  requireFile(protocolDocumentationPath);

  const allowedEntries = new Set<string>([".git", ...managedPaths]);
  const unmanagedEntries = readdirSync(targetDirectory).filter(
    (entry) => !allowedEntries.has(entry),
  );
  if (unmanagedEntries.length > 0) {
    throw new Error(
      `Target contains unmanaged paths; refusing to overwrite: ${unmanagedEntries.join(", ")}`,
    );
  }

  const stageDirectory = mkdtempSync(join(tmpdir(), "whoop-ble-swift-export-"));
  try {
    copyExportToStage(sourceDirectory, protocolDocumentationPath, stageDirectory);

    for (const managedPath of managedPaths) {
      rmSync(join(targetDirectory, managedPath), { force: true, recursive: true });
    }
    for (const managedPath of managedPaths) {
      cpSync(join(stageDirectory, managedPath), join(targetDirectory, managedPath), {
        recursive: true,
      });
    }
  } finally {
    rmSync(stageDirectory, { force: true, recursive: true });
  }

  console.log(`Exported WHOOP BLE Swift package to ${targetDirectory}`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
