import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(import.meta.dirname, "next-swift-package-version.ts");

function createRepository(tags: string[] = []): string {
  const repository = mkdtempSync(path.join(tmpdir(), "dofek-swift-version-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(path.join(repository, "README.md"), "# Fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync(
    "git",
    [
      "-C",
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { stdio: "ignore" },
  );

  for (const tag of tags) {
    execFileSync("git", ["-C", repository, "tag", tag]);
  }

  return repository;
}

function nextVersion(repository: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", scriptPath, repository], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("next Swift package version CLI", () => {
  it("starts a package at 0.1.0", () => {
    expect(nextVersion(createRepository())).toBe("0.1.0");
  });

  it("patch-bumps the greatest stable semantic version", () => {
    const repository = createRepository([
      "0.1.0",
      "0.2.7",
      "0.2.8-beta.1",
      "@dofek/whoop-ble@9.0.0",
    ]);

    expect(nextVersion(repository)).toBe("0.2.8");
  });

  it("fails when the argument is not a Git repository", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dofek-not-git-"));

    expect(() => nextVersion(directory)).toThrow();
  });
});
