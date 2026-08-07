import { describe, expect, it } from "vitest";
import {
  buildReviewClickHouseCopyStatements,
  buildReviewPostgresTableFunction,
} from "./seed-review-clickhouse.ts";

describe("seed-review-clickhouse", () => {
  it("builds a ClickHouse Postgres table function from DATABASE_URL", () => {
    expect(
      buildReviewPostgresTableFunction("postgres://health:pa%24%24@db:5432/health", "activity"),
    ).toBe("postgresql('db:5432', 'health', 'activity', 'health', 'pa$$', 'fitness')");
  });

  it("copies seeded relational activity dependencies", () => {
    const statements = buildReviewClickHouseCopyStatements(
      "postgres://health:health@db:5432/health",
    );

    expect(statements).toContain("TRUNCATE TABLE IF EXISTS postgres_fitness.activity");
    expect(statements.join("\n")).toContain("INSERT INTO postgres_fitness.activity");
    expect(statements.join("\n")).toContain(
      "WHERE user_id = '00000000-0000-4000-8000-000000000001'",
    );
  });

  it("adds deterministic body-weight samples through the canonical metric stream", () => {
    const statements = buildReviewClickHouseCopyStatements(
      "postgres://health:health@db:5432/health",
    );
    const seedStatement = statements.find(
      (statement) =>
        statement.startsWith("INSERT INTO ingest.metric_stream") &&
        statement.includes("numbers(90)"),
    );

    expect(seedStatement).toContain("'body_weight'");
    expect(seedStatement).toContain("'review-seed-body-weight-'");
    expect(seedStatement).toContain("numbers(90)");
    expect(statements.join("\n")).not.toContain("TRUNCATE TABLE IF EXISTS ingest.metric_stream");
  });

  it("names every metric-stream target column for seed inserts and tombstones", () => {
    const statements = buildReviewClickHouseCopyStatements(
      "postgres://health:health@db:5432/health",
    ).filter((statement) => statement.startsWith("INSERT INTO ingest.metric_stream"));

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).toMatch(
        /^INSERT INTO ingest\.metric_stream \(\s*id,\s*activity_id,\s*user_id,/,
      );
      expect(statement).toContain("generation\n)");
    }
  });
});
