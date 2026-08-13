import { describe, expect, it } from "vitest";
import {
  compactWhitespace,
  extractCteSql,
  readModelSql,
  renderDbtModelSql,
} from "./read-model-sql-test-helpers.ts";

describe("compactWhitespace", () => {
  it("collapses each whitespace run to one space", () => {
    expect(compactWhitespace("SELECT\n  value\tFROM source")).toBe("SELECT value FROM source");
  });
});

describe("extractCteSql", () => {
  it("matches CTE names case-insensitively with flexible whitespace", () => {
    const sql = `
WITH sample_cte   as   (
  SELECT 1
)
SELECT * FROM sample_cte
`;

    expect(extractCteSql(sql, "sample_cte")).toContain("SELECT 1");
    expect(extractCteSql(sql, "SAMPLE_CTE")).toContain("SELECT 1");
  });

  it("matches CTE headers with comments between the name, AS, and opening parenthesis", () => {
    const sql = `
WITH block_commented /* explanation */ AS (
  SELECT 1 AS value
),
line_commented AS -- explanation
(
  SELECT 2 AS value
)
SELECT * FROM block_commented
`;

    expect(extractCteSql(sql, "block_commented")).toContain("SELECT 1");
    expect(extractCteSql(sql, "line_commented")).toContain("SELECT 2");
  });

  it("matches materialized CTE headers", () => {
    const sql = `
WITH reusable AS materialized (
  SELECT 1 AS value
)
SELECT * FROM reusable
`;

    expect(extractCteSql(sql, "reusable")).toContain("SELECT 1");
  });

  it("ignores parentheses inside quotes and SQL comments", () => {
    const sql = `
WITH commented AS (
  -- ignore closing paren in comment: )
  SELECT '(' AS opener,
  /* block comment with ) inside */
  coalesce(value, ')') AS literal
)
SELECT * FROM commented
`;

    const body = extractCteSql(sql, "commented");

    expect(body).toContain("ignore closing paren");
    expect(body).toContain("coalesce(value, ')')");
    expect(body).not.toContain("SELECT * FROM commented");
  });

  it("handles escaped single quotes inside string literals", () => {
    const sql = `
WITH quoted AS (
  SELECT 'it''s fine (still in string)' AS label
)
SELECT * FROM quoted
`;

    expect(extractCteSql(sql, "quoted")).toContain("it''s fine (still in string)");
  });

  it("ignores CTE-like text in comments and string literals while finding the start", () => {
    const sql = `
-- target AS (SELECT 'wrong')
WITH decoy AS (
  SELECT 'target AS (SELECT wrong)' AS label
),
target AS (
  SELECT 'right' AS label
)
SELECT * FROM target
`;

    const body = extractCteSql(sql, "target");

    expect(body).toContain("SELECT 'right'");
    expect(body).not.toContain("wrong");
  });
});

describe("renderDbtModelSql", () => {
  const modelSql = `
{% set batch_size = var('batch_size', 1) %}
{{ config(materialized='incremental') }}
WITH state AS (
  SELECT 1
  {% if is_incremental() %}
  WHERE active = 1
  {% else %}
  WHERE active = 0
  {% endif %}
)
SELECT * FROM state
`;

  it("removes dbt wrappers and selects the incremental branch", () => {
    const renderedSql = renderDbtModelSql(modelSql, { isIncremental: true });

    expect(renderedSql).not.toContain("{% ");
    expect(renderedSql).not.toContain("{{ config");
    expect(renderedSql).toContain("WHERE active = 1");
    expect(renderedSql).not.toContain("WHERE active = 0");
  });

  it("selects the initial branch when incremental mode is disabled", () => {
    expect(renderDbtModelSql(modelSql, { isIncremental: false })).toContain(
      "WHERE active = 0",
    );
  });

  it("removes every incremental-only branch from cycling_activity initial SQL", () => {
    const renderedSql = renderDbtModelSql(readModelSql("cycling_activity.sql"), {
      isIncremental: false,
    });

    expect(renderedSql).not.toContain("{{ this }}");
    expect(renderedSql).not.toContain("existing_rows AS");
    expect(renderedSql).not.toContain("tombstone_rows");
  });
});
