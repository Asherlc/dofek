import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("sleep_heart_rate_window.sql");

describe("sleep_heart_rate_window model", () => {
  it("uses compact day changes for discovery and scans exact sensor rows only for selected keys", () => {
    const heartRateChangesSql = extractCteSql(modelSql, "heart_rate_changes");
    const currentWindowsSql = extractCteSql(modelSql, "current_windows").replace(/\s+/g, " ");

    expect(heartRateChangesSql).toContain("source('analytics', 'heart_rate_day_change')");
    expect(heartRateChangesSql).not.toContain("ref('deduped_sensor')");
    expect(currentWindowsSql).toContain("ref('deduped_sensor')");
    expect(currentWindowsSql).toContain(
      "samples.recorded_at >= active_dirty_sleep.started_at",
    );
    expect(currentWindowsSql).toContain("overlapping_activity.id IS NULL");
  });

  it("bounds bootstrap and change processing on every invocation", () => {
    const dirtyKeysSql = extractCteSql(modelSql, "dirty_keys").replace(/\s+/g, " ");
    const sourceDirtySql = extractCteSql(modelSql, "source_dirty_sleep_keys").replace(/\s+/g, " ");

    expect(modelSql).toContain("full_refresh=false");
    expect(modelSql).toContain("initial_lookback_days");
    expect(sourceDirtySql).toContain("existing_sleep_state.sleep_id IS NULL");
    expect(sourceDirtySql).toContain("INTERVAL {{ initial_lookback_days }} DAY");
    expect(dirtyKeysSql).toContain("LIMIT {{ sleep_dirty_key_batch_size }}");
    expect(dirtyKeysSql).not.toContain("{% if is_incremental() %}");
  });

  it("records empty active windows and requires positive prior lifecycle evidence for tombstones", () => {
    const currentWindowsSql = extractCteSql(modelSql, "current_windows");
    const staleKeysSql = extractCteSql(modelSql, "stale_sleep_dirty_keys").replace(/\s+/g, " ");

    expect(currentWindowsSql).toContain("countIf");
    expect(currentWindowsSql).toContain("eligible_sample_count");
    expect(staleKeysSql).toContain("existing_sleep_state.is_deleted = 0");
    expect(staleKeysSql).toContain("current_sleep_state.sleep_id IS NULL");
  });
});
