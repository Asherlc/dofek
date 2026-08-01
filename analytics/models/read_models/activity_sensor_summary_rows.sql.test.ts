import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildActivitySensorSummaryRowsTableSql,
  extractClickHouseTableColumnNames,
  extractDbtFinalSelectColumnNames,
} from "../../../src/db/clickhouse-activity-sensor-summary.ts";

const modelSql = readFileSync(
  new URL("./activity_sensor_summary_rows.sql", import.meta.url),
  "utf8",
);

describe("activity_sensor_summary_rows model", () => {
  it("matches the canonical ClickHouse table column order", () => {
    const tableColumns = extractClickHouseTableColumnNames(buildActivitySensorSummaryRowsTableSql());
    const selectColumns = extractDbtFinalSelectColumnNames(modelSql, "dirty_keys");

    expect(selectColumns).toEqual(tableColumns);
  });

  it("fails on schema drift instead of appending columns at the table tail", () => {
    expect(modelSql).toContain("on_schema_change='fail'");
    expect(modelSql).not.toContain("append_new_columns");
  });

  it("preserves unavailable elevation separately from measured zero", () => {
    expect(modelSql).toContain(
      "elevation_per_activity.elevation_gain_m AS elevation_gain_m",
    );
    expect(modelSql).not.toContain(
      "coalesce(elevation_per_activity.elevation_gain_m, CAST(0, 'Nullable(Float64)'))",
    );
    expect(modelSql).toContain(
      "elevation_per_activity.elevation_loss_m AS elevation_loss_m",
    );
    expect(modelSql).toContain("countIf(altitude - prev_altitude < 0) = 0");
    expect(modelSql).toContain(
      "sumIf(abs(altitude - prev_altitude), altitude - prev_altitude < 0)",
    );
    expect(modelSql).not.toContain(
      "coalesce(elevation_per_activity.elevation_loss_m, CAST(0, 'Nullable(Float64)'))",
    );
  });

  it("materializes only the reused dirty, sample, and power stages", () => {
    expect(modelSql).toContain("'enable_materialized_cte': 1");
    expect(modelSql).toContain("dirty_keys AS materialized (");
    expect(modelSql).toContain("latest_sensor_samples AS materialized (");
    expect(modelSql).toContain("power_cumulative AS materialized (");
    expect(modelSql.match(/ AS materialized \(/g)).toHaveLength(3);
  });

  describe("best_twenty_minute_power_per_activity window-sample-count clamp", () => {
    it("keeps power sample rate safe before ClickHouse applies HAVING", () => {
      expect(modelSql).toContain("/ greatest(count() - 1, 1)");
      expect(modelSql).not.toContain("/ nullIf(count() - 1, 0)");
    });

    it("clamps the divisor to at least 1 so slow power cadences cannot divide by zero", () => {
      // Three call sites must use the same guarded expression, so a slow power
      // cadence (interval_seconds > 1200) cannot round the 20-minute window
      // sample count down to 0 and emit NaN from `0 / 0` or a self-match join.
      const guardedDivisorMatches =
        modelSql.match(
          /greatest\s*\(\s*round\s*\(\s*1200\.0\s*\/\s*power_sample_rate\.interval_seconds\s*\)\s*,\s*1\s*\)/g,
        ) ?? [];
      expect(guardedDivisorMatches).toHaveLength(3);
    });

    it("leaves no unguarded 20-minute window sample count expression", () => {
      const guardedDivisorPattern =
        /greatest\s*\(\s*round\s*\(\s*1200\.0\s*\/\s*power_sample_rate\.interval_seconds\s*\)\s*,\s*1\s*\)/g;
      const sqlWithoutGuardedDivisors = modelSql.replaceAll(guardedDivisorPattern, "");
      const unguardedMatches =
        sqlWithoutGuardedDivisors.match(
          /round\s*\(\s*1200\.0\s*\/\s*power_sample_rate\.interval_seconds\s*\)/g,
        ) ?? [];
      expect(unguardedMatches).toHaveLength(0);
    });

    it("keeps appended power analytics columns before lifecycle columns", () => {
      const lifecycleColumnIndex = modelSql.indexOf("toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version");
      const bestTwentyMinutePowerIndex = modelSql.indexOf(
        "best_twenty_minute_power_per_activity.best_twenty_minute_power AS best_twenty_minute_power",
      );

      expect(lifecycleColumnIndex).toBeGreaterThan(-1);
      expect(bestTwentyMinutePowerIndex).toBeGreaterThan(-1);
      expect(bestTwentyMinutePowerIndex).toBeLessThan(lifecycleColumnIndex);
    });
  });
});
