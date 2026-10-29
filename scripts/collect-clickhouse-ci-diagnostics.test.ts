import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
function run(args: string[], credentialUrl?: string, path = process.env.PATH) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  delete env.CLICKHOUSE_URL;
  if (credentialUrl !== undefined) env.CLICKHOUSE_URL = credentialUrl;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("scripts/collect-clickhouse-ci-diagnostics.ts"), ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      env,
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
  it("reports filesystem operation and code without leaking its path", () => {
    const directory = mkdtempSync(join(tmpdir(), "clickhouse-diagnostics-cli-"));
    directories.push(directory);
    const file = join(directory, "private-file-path");
    writeFileSync(file, "fixture");
    const result = run(["a".repeat(64), join(file, "child")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create output directory");
    expect(result.stderr).toMatch(/ENOTDIR|EEXIST/);
    expect(result.stderr).not.toContain("inspect available artifacts");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("private-file-path");
  });
  it("collects diagnostics when CLICKHOUSE_URL is genuinely absent from the child environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "clickhouse-diagnostics-cli-"));
    directories.push(directory);
    const result = run(
      ["a".repeat(64), directory],
      undefined,
      "/no-such-diagnostics-command-directory",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("CLICKHOUSE_URL");
    expect(JSON.parse(result.stdout).failures).toContain("container");
  });
  it.each([
    ["container.stdout.log", "write capture artifact"],
    ["manifest.json", "write manifest"],
  ])("reports a failed %s write without leaking the destination", (artifact, operation) => {
    const directory = mkdtempSync(join(tmpdir(), "private-diagnostic-destination-"));
    directories.push(directory);
    mkdirSync(join(directory, artifact));
    const result = run(
      ["a".repeat(64), directory],
      undefined,
      "/no-such-diagnostics-command-directory",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(operation);
    expect(result.stderr).toContain("EISDIR");
    expect(result.stderr).not.toContain(directory);
    expect(result.stdout).toBe("");
  });
});
