import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("heart_rate_day_freshness.sql");

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("heart_rate_day_freshness model", () => {
  it("materializes daily heart-rate freshness keys from deduped_sensor", () => {
    const normalizedSql = compactWhitespace(modelSql);

    expect(modelSql).toContain("materialized='incremental'");
    expect(modelSql).toContain("incremental_strategy='append'");
    expect(modelSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(modelSql).toContain("order_by='(user_id, recorded_date)'");
    expect(modelSql).toContain("ref('deduped_sensor')");
    expect(modelSql).toContain("channel = 'heart_rate'");
    expect(modelSql).toContain("has_live_samples");
    expect(modelSql).toContain("heart_rate_day_freshness_lookback_hours");
    expect(normalizedSql).toContain("max(refreshed_at) AS max_refreshed_at FROM {{ this }}");
    expect(modelSql).toContain("'max_threads': 1");
    expect(modelSql).toContain("'join_use_nulls': 1");
  });

  it("bounds incremental scans to rows newer than the watermark lookback", () => {
    const changedDaysSql = extractCteSql(modelSql, "changed_heart_rate_days");

    expect(changedDaysSql).toContain("ref('deduped_sensor')");
    expect(changedDaysSql).toContain("channel = 'heart_rate'");
    expect(changedDaysSql).toContain("{% if is_incremental() %}");
  });
});
