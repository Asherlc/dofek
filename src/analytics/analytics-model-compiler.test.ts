import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileAnalyticsPageSql } from "./analytics-model-compiler.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const vars = { analytics_source_ids: [], analytics_keys: [], analytics_publication_revision: "1" };
let directory: string;
let node: Record<string, unknown>;
let writeManifest: boolean;
let exitCode: number;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "analytics-compiler-test-"));
  node = {
    unique_id: "model.dofek_analytics.sensor_scalar_sample",
    resource_type: "model",
    package_name: "dofek_analytics",
    name: "sensor_scalar_sample",
    alias: "sensor_scalar_sample",
    schema: "fixture",
    relation_name: "`fixture`.`sensor_scalar_sample`",
    compiled_code: "SELECT 17 AS scalar",
    config: { materialized: "incremental", incremental_strategy: "append" },
  };
  writeManifest = true;
  exitCode = 0;
  vi.mocked(spawn).mockImplementation((_command, argumentsList) => {
    const child = new ChildProcess();
    queueMicrotask(() => {
      const args = Array.from(argumentsList ?? []);
      const target = args[args.indexOf("--target-path") + 1];
      if (!target) {
        child.emit("error", new Error("Compiler did not supply a target path"));
        return;
      }
      if (writeManifest)
        writeFileSync(
          join(target, "manifest.json"),
          JSON.stringify({
            metadata: { invocation_id: "fresh-invocation" },
            nodes: { "model.dofek_analytics.sensor_scalar_sample": node },
          }),
        );
      child.emit("close", exitCode);
    });
    return child;
  });
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe("native analytics model compiler", () => {
  it("returns the exact selected manifest SQL and relation from a fresh compilation", async () => {
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({ nodes: {} }));
    const result = await compileAnalyticsPageSql({
      stage: "scalar",
      vars,
      artifactDirectory: directory,
    });
    expect(result).toMatchObject({
      sql: "SELECT 17 AS scalar",
      relation: "`fixture`.`sensor_scalar_sample`",
      nodeId: "model.dofek_analytics.sensor_scalar_sample",
    });
    expect(result.artifactDirectory).not.toBe(directory);
    expect(spawn).toHaveBeenCalledWith(
      "dbt",
      expect.arrayContaining([
        "compile",
        "--no-introspect",
        "--no-populate-cache",
        "--select",
        "sensor_scalar_sample",
        "--vars",
        JSON.stringify(vars),
      ]),
      expect.any(Object),
    );
  });
  it.each([
    ["blank SQL", { compiled_code: "  " }],
    ["wrong package", { package_name: "other" }],
    ["wrong identity", { unique_id: "model.other.sensor_scalar_sample" }],
    ["wrong resource", { resource_type: "seed" }],
    ["wrong target", { alias: "deduped_sensor" }],
    ["missing relation", { relation_name: null }],
    [
      "wrong strategy",
      { config: { materialized: "incremental", incremental_strategy: "microbatch" } },
    ],
  ])("rejects %s in the selected manifest node", async (_name, override) => {
    Object.assign(node, override);
    await expect(
      compileAnalyticsPageSql({ stage: "scalar", vars, artifactDirectory: directory }),
    ).rejects.toThrow(/manifest|compiled|model/i);
  });
  it("rejects missing selected node", async () => {
    await expect(
      compileAnalyticsPageSql({ stage: "dedup", vars, artifactDirectory: directory }),
    ).rejects.toThrow(/model|manifest/i);
  });
  it("rejects process failure even with a manifest", async () => {
    exitCode = 2;
    await expect(
      compileAnalyticsPageSql({ stage: "scalar", vars, artifactDirectory: directory }),
    ).rejects.toThrow(/dbt.*2/i);
  });
  it("does not reuse an older parent manifest when the new invocation writes none", async () => {
    writeManifest = false;
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({ nodes: { "model.dofek_analytics.sensor_scalar_sample": node } }),
    );
    await expect(
      compileAnalyticsPageSql({ stage: "scalar", vars, artifactDirectory: directory }),
    ).rejects.toThrow(/ENOENT/);
  });
  it("rejects malformed publication before starting dbt", async () => {
    await expect(
      compileAnalyticsPageSql({
        stage: "scalar",
        vars: { ...vars, analytics_publication_revision: "0" },
        artifactDirectory: directory,
      }),
    ).rejects.toThrow(/publication/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});
