import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
function run(args: string[], credentialUrl = "") {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("scripts/collect-clickhouse-ci-diagnostics.ts"), ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CLICKHOUSE_URL: credentialUrl },
    },
  );
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ClickHouse diagnostics CLI", () => {
  it("prints actionable usage for missing arguments", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: pnpm tsx scripts/collect-clickhouse-ci-diagnostics.ts");
  });
  it("identifies an invalid container prerequisite without printing the supplied identifier", () => {
    const result = run(["unsafe-private-container", "unused"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a Docker container ID");
    expect(result.stderr).not.toContain("unsafe-private-container");
  });
  it("names malformed credential configuration without revealing its value", () => {
    const result = run(["a".repeat(64), "unused"], "private-invalid-url");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLICKHOUSE_URL must be valid");
    expect(result.stderr).not.toContain("private-invalid-url");
  });
  it("keeps unexpected filesystem errors generic without leaking their path", () => {
    const directory = mkdtempSync(join(tmpdir(), "clickhouse-diagnostics-cli-"));
    directories.push(directory);
    const file = join(directory, "private-file-path");
    writeFileSync(file, "fixture");
    const result = run(["a".repeat(64), join(file, "child")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not complete");
    expect(result.stderr).not.toContain("private-file-path");
  });
});
