import { describe, expect, it } from "vitest";
import { extractCteSql } from "./read-model-sql-test-helpers.ts";

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
