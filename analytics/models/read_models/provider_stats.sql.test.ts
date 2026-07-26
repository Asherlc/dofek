import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("provider_stats.sql");

describe("provider_stats model", () => {
  it("scans the metric stream once for counts rather than again for provider discovery", () => {
    const currentProvidersSql = extractCteSql(modelSql, "current_providers");

    expect(currentProvidersSql).not.toContain("source('ingest', 'metric_stream')");
    expect(modelSql.match(/source\('ingest', 'metric_stream'\)/g)).toHaveLength(1);
  });
});
