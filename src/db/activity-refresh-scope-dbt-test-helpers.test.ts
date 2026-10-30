import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dbtFailureDiagnostic,
  readDbtCompiledQueries,
  readDbtStatementMessages,
  readDbtStatementTarget,
} from "./activity-refresh-scope-dbt-test-helpers.ts";

describe("readDbtCompiledQueries", () => {
  const directories: string[] = [];
  const models = ["activity_source_records", "activity_sensor_sample"];
  const compiledRoot = "compiled/dofek_analytics/models-0/read_models";
  const sourcePath = `${compiledRoot}/activity_source_records.sql`;
  const firstBatchPath = `${compiledRoot}/activity_sensor_sample/activity_sensor_sample_2026-09-01.sql`;
  const secondBatchPath = `${compiledRoot}/activity_sensor_sample/activity_sensor_sample_2026-09-02.sql`;

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const target = await mkdtemp(join(tmpdir(), "compiled-scope-test-"));
    directories.push(target);
    const metadata = { invocation_id: "10000000-0000-4000-8000-000000000001" };
    const manifest = {
      metadata,
      nodes: Object.fromEntries(
        models.map((name) => [
          `model.dofek_analytics.${name}`,
          {
            unique_id: `model.dofek_analytics.${name}`,
            name,
            resource_type: "model",
            package_name: "dofek_analytics",
            path: `read_models/${name}.sql`,
            original_file_path: `models-0/read_models/${name}.sql`,
            // Parent microbatch nodes have no compiled_code; normal nodes may have it.
            ...(name === "activity_source_records" ? { compiled_code: "manifest decoy" } : {}),
            raw_code: "{{ unrendered_source() }}",
            config: {
              incremental_strategy: name === "activity_sensor_sample" ? "microbatch" : "append",
              batch_size: name === "activity_sensor_sample" ? "day" : null,
              query_settings: { max_threads: 1, join_use_nulls: 1 },
            },
          },
        ]),
      ),
    };
    const failed: string[][] = [];
    const results = {
      metadata,
      results: [
        {
          unique_id: "model.dofek_analytics.activity_source_records",
          status: "success",
          batch_results: null,
        },
        {
          unique_id: "model.dofek_analytics.activity_sensor_sample",
          status: "success",
          batch_results: {
            successful: [
              ["2026-09-01T00:00:00+00:00", "2026-09-02T00:00:00+00:00"],
              ["2026-09-02T00:00:00+00:00", "2026-09-03T00:00:00+00:00"],
            ],
            failed,
          },
        },
      ],
    };
    await writeFile(join(target, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(target, "run_results.json"), JSON.stringify(results));
    for (const [path, sql] of [
      [sourcePath, "\nSELECT 'normal' AS value\n"],
      [firstBatchPath, "\nSELECT 'first batch' AS value\n"],
      [secondBatchPath, "\nSELECT 'second batch' AS value\n"],
    ]) {
      if (!path || !sql) throw new Error("Incomplete compiled fixture");
      await mkdir(dirname(join(target, path)), { recursive: true });
      await writeFile(join(target, path), sql);
    }
    return { target, manifest, results };
  }

  it("reads verbatim compiled files for normal models and every successful batch without parent compiled SQL", async () => {
    const { target } = await fixture();
    expect(await readDbtCompiledQueries(target, models)).toEqual([
      {
        model: "activity_source_records",
        batch: null,
        path: sourcePath,
        sql: "\nSELECT 'normal' AS value\n",
        settings: { max_threads: 1, join_use_nulls: 1 },
      },
      {
        model: "activity_sensor_sample",
        batch: "2026-09-01",
        path: firstBatchPath,
        sql: "\nSELECT 'first batch' AS value\n",
        settings: { max_threads: 1, join_use_nulls: 1 },
      },
      {
        model: "activity_sensor_sample",
        batch: "2026-09-02",
        path: secondBatchPath,
        sql: "\nSELECT 'second batch' AS value\n",
        settings: { max_threads: 1, join_use_nulls: 1 },
      },
    ]);
  });

  it("reads the requested invocation directory rather than a previous phase", async () => {
    const previous = await fixture();
    const current = await fixture();
    await writeFile(join(current.target, sourcePath), "SELECT 'incremental' AS value");
    expect((await readDbtCompiledQueries(current.target, models))[0]?.sql).toBe(
      "SELECT 'incremental' AS value",
    );
    expect(await readFile(join(previous.target, sourcePath), "utf8")).toBe(
      "\nSELECT 'normal' AS value\n",
    );
  });

  it("rejects artifacts from different invocations", async () => {
    const { target, results } = await fixture();
    results.metadata.invocation_id = "20000000-0000-4000-8000-000000000002";
    await writeFile(join(target, "run_results.json"), JSON.stringify(results));
    await expect(readDbtCompiledQueries(target, models)).rejects.toThrow("invocation");
  });

  it.each([sourcePath, firstBatchPath, secondBatchPath])(
    "fails when the required compiled file %s is missing",
    async (path) => {
      const { target } = await fixture();
      await rm(join(target, path));
      await expect(readDbtCompiledQueries(target, models)).rejects.toThrow();
    },
  );

  it("rejects an extra batch artifact rather than mixing stale SQL into the current inventory", async () => {
    const { target } = await fixture();
    await writeFile(
      join(target, compiledRoot, "activity_sensor_sample/activity_sensor_sample_2026-08-31.sql"),
      "SELECT 'stale batch'",
    );
    await expect(readDbtCompiledQueries(target, models)).rejects.toThrow(
      "batch artifact inventory",
    );
  });

  it("rejects a manifest entry attributed to a different model", async () => {
    const { target, manifest } = await fixture();
    const node = manifest.nodes["model.dofek_analytics.activity_sensor_sample"];
    if (!node) throw new Error("Missing fixture model");
    node.name = "another_model";
    await writeFile(join(target, "manifest.json"), JSON.stringify(manifest));
    await expect(readDbtCompiledQueries(target, models)).rejects.toThrow("identity");
  });

  it.each(["missing", "duplicate", "failed"])("rejects a %s model result", async (state) => {
    const { target, results } = await fixture();
    const result = results.results[0];
    if (!result) throw new Error("Missing fixture result");
    if (state === "missing") results.results.shift();
    if (state === "duplicate") results.results.push(result);
    if (state === "failed") result.status = "error";
    await writeFile(join(target, "run_results.json"), JSON.stringify(results));
    await expect(readDbtCompiledQueries(target, models)).rejects.toThrow("successful result");
  });

  it.each(["empty", "duplicate", "failed"])("rejects %s microbatch results", async (state) => {
    const { target, results } = await fixture();
    const batches = results.results[1]?.batch_results;
    const first = batches?.successful[0];
    if (!batches || !first) throw new Error("Missing fixture batches");
    if (state === "empty") batches.successful = [];
    if (state === "duplicate") batches.successful.push(first);
    if (state === "failed") batches.failed = [first];
    await writeFile(join(target, "run_results.json"), JSON.stringify(results));
    await expect(readDbtCompiledQueries(target, models)).rejects.toThrow("batch results");
  });
});

describe("readDbtStatementMessages", () => {
  it("retains the complete commented statement and settings from the pinned adapter event", () => {
    const sql =
      '/* {"app":"dbt"} */\nINSERT INTO "analytics"."activity_source_records"\nSELECT \'...\'\nSETTINGS max_threads = 1';
    const log = [
      {
        info: {
          msg: `dbt_clickhouse adapter: On model.dofek_analytics.activity_source_records: ${sql}...`,
        },
      },
      { info: { msg: "dbt_clickhouse adapter: SQL status: OK in 0.01 seconds" } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(readDbtStatementMessages(log)).toEqual([sql]);
  });
});

describe("readDbtStatementTarget", () => {
  it.each([
    [
      '/* dbt model: dependency */\ncreate table "scope"."activity_source_records" ENGINE=MergeTree AS SELECT 1',
      "create",
    ],
    ["-- dbt query\nINSERT INTO `scope`.`activity_source_records` (id) SELECT 1", "insert"],
  ])("identifies the operation and exact target despite leading comments", (query, operation) => {
    expect(readDbtStatementTarget(query)).toEqual({
      operation,
      database: "scope",
      model: "activity_source_records",
    });
  });

  it("identifies the target rather than dependency references, string literals or prefixes", () => {
    expect(
      readDbtStatementTarget(
        `INSERT INTO "other"."activity_source_records_copy" SELECT 'create table scope.activity_source_records' FROM "scope"."activity_source_records"`,
      ),
    ).toEqual({ operation: "insert", database: "other", model: "activity_source_records_copy" });
    expect(readDbtStatementTarget('SELECT * FROM "scope"."activity_source_records"')).toBeNull();
  });
});

describe("dbtFailureDiagnostic", () => {
  it("keeps the first fatal message while redacting packed and partial payloads in both streams before bounding output", () => {
    const packed = Buffer.alloc(160000).toString("base64");
    const stdout = [
      { info: { level: "debug", msg: `SQL base64Decode('${packed}')` } },
      { info: { level: "error", msg: `Code62 first fatal base64Decode('${packed}')` } },
      { info: { level: "error", msg: `later error ${"detail ".repeat(1000)}` } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const result = dbtFailureDiagnostic(
      { stdout, stderr: `stderr fatal: ${packed} truncated: ${packed.slice(0, 200)}` },
      packed,
    );
    expect(result).toContain("Code62 first fatal");
    expect(result).toContain("stderr fatal");
    expect(result).toContain("<packed UUID scope>");
    expect(result.includes(packed.slice(0, 64))).toBe(false);
    expect(result.length).toBeLessThanOrEqual(5000);
  });

  it("redacts escaped malformed input and safely handles an empty scope", () => {
    const packed = `${Buffer.alloc(16).toString("base64")}\n`;
    const result = dbtFailureDiagnostic(
      {
        stdout: JSON.stringify({
          info: { level: "error", msg: `canonical base64 rejected: ${packed}` },
        }),
        stderr: JSON.stringify(packed),
      },
      packed,
    );
    expect(result).toContain("canonical base64 rejected");
    expect(result.includes(packed.trim())).toBe(false);
    expect(dbtFailureDiagnostic({ stdout: "", stderr: "empty scope rejected" }, "")).toContain(
      "empty scope rejected",
    );
  });
});
