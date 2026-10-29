import { describe, expect, it } from "vitest";
import {
  dbtFailureDiagnostic,
  readDbtStatementMessages,
  readDbtStatementTarget,
} from "./activity-refresh-scope-dbt-test-helpers.ts";

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
