import { describe, expect, it } from "vitest";
import {
  buildReviewClickHouseCopyStatements,
  buildReviewPostgresTableFunction,
} from "./seed-review-clickhouse.ts";

describe("seed-review-clickhouse", () => {
  it("builds a ClickHouse Postgres table function from DATABASE_URL", () => {
    expect(
      buildReviewPostgresTableFunction(
        "postgres://health:pa%24%24@db:5432/health",
        "metric_stream",
      ),
    ).toBe("postgresql('db:5432', 'health', 'metric_stream', 'health', 'pa$$', 'fitness')");
  });

  it("copies seeded activity dependencies into ClickHouse raw tables", () => {
    const statements = buildReviewClickHouseCopyStatements(
      "postgres://health:health@db:5432/health",
    );

    expect(statements).toContain("TRUNCATE TABLE IF EXISTS postgres_fitness.activity");
    expect(statements).toContain("TRUNCATE TABLE IF EXISTS ingest.metric_stream");
    expect(statements.join("\n")).toContain("INSERT INTO postgres_fitness.activity");
    expect(statements.join("\n")).toContain("INSERT INTO ingest.metric_stream");
    expect(statements.join("\n")).toContain("ingested_at, is_deleted, version");
    expect(statements.join("\n")).not.toContain(
      "INSERT INTO ingest.metric_stream (recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, activity_id, scalar, point, id, _peerdb_synced_at",
    );
    expect(statements.join("\n")).toContain(
      "WHERE user_id = '00000000-0000-0000-0000-000000000001'",
    );
    expect(statements.join("\n")).toContain("readWKBPoint");
  });
});
