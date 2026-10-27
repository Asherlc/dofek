import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

const modelSql = readModelSql("sleep_heart_rate_sample.sql");

describe("sleep_heart_rate_sample model", () => {
  it("projects bounded sample-grain changes from exact sleep windows", () => {
    const currentWindowsSql = extractCteSql(modelSql, "current_windows");
    const dirtyKeysSql = extractCteSql(modelSql, "dirty_keys").replace(/\s+/g, " ");
    const sourceDirtySql = extractCteSql(modelSql, "source_dirty_sleep_keys").replace(/\s+/g, " ");

    expect(modelSql).toContain("ref('sleep_heart_rate_window')");
    expect(modelSql).toContain("ref('deduped_sensor')");
    expect(modelSql).toContain("source('postgres_fitness', 'activity')");
    expect(modelSql).toContain("full_refresh=false");
    expect(currentWindowsSql).toContain("eligible_sample_count");
    expect(sourceDirtySql).toContain("current_windows.eligible_sample_count > 0");
    expect(dirtyKeysSql).toContain("LIMIT {{ sleep_dirty_key_batch_size }}");
  });

  it("bounds existing state and sensor reads to the current dirty source keys", async () => {
    const existingStateSql = extractCteSql(modelSql, "existing_sleep_state").replace(/\s+/g, " ");
    const currentSamplesSql = extractCteSql(modelSql, "current_samples").replace(/\s+/g, " ");

    expect(existingStateSql).toContain(
      "(user_id, sleep_id) IN ( SELECT user_id, sleep_id FROM current_windows )",
    );
    expect(currentSamplesSql).toContain("INNER JOIN dirty_sleep_dates");
    expect(currentSamplesSql).toContain("dirty_sleep_dates.user_id = samples.user_id");
    expect(currentSamplesSql).toContain(
      "dirty_sleep_dates.recorded_date = samples.recorded_date",
    );
  });

  it("only emits lifecycle tombstones for previously active samples", () => {
    const staleKeysSql = extractCteSql(modelSql, "stale_sleep_dirty_keys").replace(/\s+/g, " ");

    expect(staleKeysSql).toContain("existing_sleep_state.has_active_samples");
    expect(staleKeysSql).toContain("current_windows.eligible_sample_count = 0");
    expect(staleKeysSql).toContain(
      "current_windows.refreshed_at > existing_sleep_state.refreshed_at",
    );
    expect(modelSql).not.toContain("OR NOT existing_sleep_state.has_active_samples");
  });
});
