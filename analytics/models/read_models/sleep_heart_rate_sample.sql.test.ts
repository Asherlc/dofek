import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("sleep_heart_rate_sample.sql");

describe("sleep_heart_rate_sample model", () => {
  it("bounds the deduped sensor scan to dirty sleep dates", () => {
    const currentSamplesSql = extractCteSql(modelSql, "current_samples");

    expect(modelSql).toContain("dirty_sleep_dates AS (");
    expect(currentSamplesSql).toContain("(samples.user_id, samples.recorded_date) IN (");
    expect(currentSamplesSql).toContain("FROM dirty_sleep_dates");
  });
});
