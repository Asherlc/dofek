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
      "WHERE user_id = '00000000-0000-0000-0000-000000000001'",
    );
  });
});
