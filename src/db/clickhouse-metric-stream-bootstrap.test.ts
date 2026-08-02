import { describe, expect, it } from "vitest";
import { buildActivitySummaryReadModelStatements } from "./clickhouse-metric-stream-bootstrap.ts";

describe("buildActivitySummaryReadModelStatements", () => {
  const sql = buildActivitySummaryReadModelStatements().join("\n");

  it("provides serving-row freshness to isolated integration tables", () => {
    expect(sql).toContain("now64(9) AS refreshed_at");
  });

  it("preserves unavailable activity metrics instead of coalescing them to zero", () => {
    expect(sql).toContain("distance_per_activity.total_distance) AS total_distance");
    expect(sql).not.toContain(
      "coalesce(distance_per_activity.total_distance, CAST(0, 'Nullable(Float64)'))",
    );
    expect(sql).toContain("elevation_per_activity.elevation_gain_m AS elevation_gain_m");
    expect(sql).not.toContain(
      "coalesce(elevation_per_activity.elevation_gain_m, CAST(0, 'Nullable(Float64)'))",
    );
    expect(sql).toContain("elevation_per_activity.elevation_loss_m AS elevation_loss_m");
    expect(sql).not.toContain(
      "coalesce(elevation_per_activity.elevation_loss_m, CAST(0, 'Nullable(Float64)'))",
    );
    expect(sql).not.toContain("countIf(altitude - prev_altitude < 0) = 0");
  });

  describe("best_twenty_minute_power_per_activity window-sample-count clamp", () => {
    it("keeps power sample rate safe before ClickHouse applies HAVING", () => {
      expect(sql).toContain("/ greatest(count() - 1, 1)");
      expect(sql).not.toContain("/ nullIf(count() - 1, 0)");
    });

    it("clamps the divisor to at least 1 so slow power cadences cannot divide by zero", () => {
      // Three call sites must use the same guarded expression, so a slow power
      // cadence (interval_seconds > 1200) cannot round the 20-minute window
      // sample count down to 0 and produce NaN from `0 / 0`.
      const guardedDivisorMatches =
        sql.match(/greatest\(round\(1200\.0 \/ power_sample_rate\.interval_seconds\), 1\)/g) ?? [];
      expect(guardedDivisorMatches).toHaveLength(3);
    });

    it("leaves no unguarded 20-minute window sample count expression", () => {
      // The pre-clamp form `round(1200.0 / power_sample_rate.interval_seconds)`
      // must not appear on its own; every occurrence must be wrapped in
      // `greatest(..., 1)`.
      const unguardedMatches =
        sql.match(
          /(?<!greatest\()round\(1200\.0 \/ power_sample_rate\.interval_seconds\)(?!, 1\))/g,
        ) ?? [];
      expect(unguardedMatches).toHaveLength(0);
    });
  });
});
