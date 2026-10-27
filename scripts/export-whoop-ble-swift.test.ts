import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/export-whoop-ble-swift.ts");
const tsxPath = resolve("node_modules/.bin/tsx");

interface Fixture {
  targetDirectory: string;
  workspaceDirectory: string;
}

function createFixture(options: { includeReadme?: boolean } = {}): Fixture {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), "whoop-ble-export-test-"));
  const sourceDirectory = join(workspaceDirectory, "packages/mobile/modules/whoop-ble");
  const targetDirectory = join(workspaceDirectory, "target");

  mkdirSync(join(sourceDirectory, "ios/nested"), { recursive: true });
  mkdirSync(join(sourceDirectory, "Tests/fixtures"), { recursive: true });
  mkdirSync(join(workspaceDirectory, "docs"), { recursive: true });
  mkdirSync(join(targetDirectory, ".git"), { recursive: true });
  writeFileSync(join(sourceDirectory, "Package.swift"), "// package\n");
  writeFileSync(join(sourceDirectory, "LICENSE"), "MIT\n");
  if (options.includeReadme !== false) {
    writeFileSync(join(sourceDirectory, "README.swift.md"), "# Native WHOOP BLE\n");
  }
  writeFileSync(join(sourceDirectory, "ios/FrameParser.swift"), "// parser\n");
  writeFileSync(join(sourceDirectory, "ios/WhoopBleModule.swift"), "// Expo bridge\n");
  writeFileSync(join(sourceDirectory, "ios/ExpoWhoopBle.podspec"), "Pod::Spec.new\n");
  writeFileSync(join(sourceDirectory, "ios/nested/Ignored.swift"), "// nested\n");
  writeFileSync(join(sourceDirectory, "Tests/FrameParserTests.swift"), "// tests\n");
  writeFileSync(join(sourceDirectory, "Tests/fixtures/capture.tsv"), "capture\n");
  writeFileSync(join(workspaceDirectory, "docs/whoop-ble-protocol.md"), "# Protocol\n");
  writeFileSync(join(targetDirectory, ".git/HEAD"), "ref: refs/heads/main\n");

  return { targetDirectory, workspaceDirectory };
}

function runExporter(workspaceDirectory: string, targetDirectory?: string) {
  return spawnSync(
    tsxPath,
    targetDirectory === undefined ? [scriptPath] : [scriptPath, targetDirectory],
    {
      cwd: workspaceDirectory,
      encoding: "utf8",
    },
  );
}

function listTree(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? [path, ...listTree(directory, path)] : [path];
  });
}

describe("export-whoop-ble-swift", () => {
  it("replaces managed export paths while preserving .git", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.targetDirectory, "ios"));
    writeFileSync(join(fixture.targetDirectory, "Package.swift"), "// stale\n");
    writeFileSync(join(fixture.targetDirectory, "ios/Stale.swift"), "// stale\n");

    try {
      const result = runExporter(fixture.workspaceDirectory, fixture.targetDirectory);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(
        `Exported WHOOP BLE Swift package to ${realpathSync(fixture.targetDirectory)}`,
      );
      expect(result.stderr).toBe("");
      expect(listTree(fixture.targetDirectory).sort()).toEqual(
        [
          ".git",
          ".git/HEAD",
          "Documentation",
          "Documentation/WHOOP-BLE-Protocol.md",
          "LICENSE",
          "Package.swift",
          "README.md",
          "Tests",
          "Tests/FrameParserTests.swift",
          "Tests/fixtures",
          "Tests/fixtures/capture.tsv",
          "ios",
          "ios/FrameParser.swift",
        ].sort(),
      );
      expect(readFileSync(join(fixture.targetDirectory, ".git/HEAD"), "utf8")).toBe(
        "ref: refs/heads/main\n",
      );
      expect(readFileSync(join(fixture.targetDirectory, "README.md"), "utf8")).toBe(
        "# Native WHOOP BLE\n",
      );
      expect(readFileSync(join(fixture.targetDirectory, "Package.swift"), "utf8")).toBe(
        "// package\n",
      );
    } finally {
      rmSync(fixture.workspaceDirectory, { force: true, recursive: true });
    }
  });

  it("fails before replacing an export when the native README is missing", () => {
    const fixture = createFixture({ includeReadme: false });
    writeFileSync(join(fixture.targetDirectory, "Package.swift"), "// keep me\n");

    try {
      const result = runExporter(fixture.workspaceDirectory, fixture.targetDirectory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("README.swift.md");
      expect(readFileSync(join(fixture.targetDirectory, "Package.swift"), "utf8")).toBe(
        "// keep me\n",
      );
    } finally {
      rmSync(fixture.workspaceDirectory, { force: true, recursive: true });
    }
  });

  it("refuses targets containing unmanaged files", () => {
    const fixture = createFixture();
    const unmanagedPath = join(fixture.targetDirectory, "notes.txt");
    writeFileSync(unmanagedPath, "keep\n");

    try {
      const result = runExporter(fixture.workspaceDirectory, fixture.targetDirectory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unmanaged");
      expect(readFileSync(unmanagedPath, "utf8")).toBe("keep\n");
    } finally {
      rmSync(fixture.workspaceDirectory, { force: true, recursive: true });
    }
  });

  it("requires an existing target directory", () => {
    const fixture = createFixture();
    const missingTarget = join(fixture.workspaceDirectory, "missing");

    try {
      const result = runExporter(fixture.workspaceDirectory, missingTarget);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must already exist");
      expect(existsSync(missingTarget)).toBe(false);
    } finally {
      rmSync(fixture.workspaceDirectory, { force: true, recursive: true });
    }
  });

  it("requires exactly one target argument", () => {
    const fixture = createFixture();

    try {
      const result = runExporter(fixture.workspaceDirectory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Usage:");
    } finally {
      rmSync(fixture.workspaceDirectory, { force: true, recursive: true });
    }
  });

  it("refuses targets that overlap the source tree or workspace", () => {
    const fixture = createFixture();
    const sourceDirectory = join(fixture.workspaceDirectory, "packages/mobile/modules/whoop-ble");
    const insideSource = join(sourceDirectory, "export");
    mkdirSync(insideSource);

    try {
      for (const unsafeTarget of [fixture.workspaceDirectory, sourceDirectory, insideSource]) {
        const result = runExporter(fixture.workspaceDirectory, unsafeTarget);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unsafe target");
      }
    } finally {
      rmSync(fixture.workspaceDirectory, { force: true, recursive: true });
    }
  });
});
