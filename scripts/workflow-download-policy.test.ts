import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const policyScript = path.resolve("scripts/workflow-download-policy.ts");
const tsxCli = require.resolve("tsx/cli");

function runPolicy(fixtureName: string) {
  return spawnSync(
    process.execPath,
    [tsxCli, policyScript, path.resolve("scripts/fixtures/workflow-download-policy", fixtureName)],
    { encoding: "utf8" },
  );
}

describe("workflow executable-download policy", () => {
  it("rejects executable and checksum downloads from mutable Git refs", () => {
    const result = runPolicy("mutable");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("mutable Git ref 'main'");
    expect(result.stdout).toContain("mutable Git ref 'master'");
    expect(result.stdout).toContain("mutable Git ref 'v1.7.12'");
    expect(result.stdout).toContain("download-actionlint.bash");
    expect(result.stdout).toContain("actionlint_checksums.txt");
    expect(result.stdout).toContain("archive/refs/heads/main.tar.gz");
    expect(result.stdout).toContain("codeload.github.com/example/tool/tar.gz/main");
  });

  it("accepts release artifacts protected by reviewed or immutable checksums", () => {
    const result = runPolicy("pinned");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No mutable Git-ref downloads found");
  });
});
