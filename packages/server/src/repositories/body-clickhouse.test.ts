import { describe, expect, it } from "vitest";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import {
  fetchBodyComparisonRows,
  fetchBodyCompRows,
  fetchBodyWeightRows,
} from "./body-clickhouse.ts";

describe("fetchBodyWeightRows", () => {
  it("excludes non-positive weights from chart queries", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(_schema, query, params) {
        calls.push({ query, params });
        return [];
      },
    };

    await fetchBodyWeightRows(store, "user-1", "UTC", "now", 90);

    expect(calls[0]?.query).toContain("AND weight_kg > 0");
    expect(calls[0]?.query).toContain("analytics.daily_body_measurement FINAL");
    expect(calls[0]?.query).toContain("AND is_deleted = 0");
    expect(calls[0]?.query).not.toContain("analytics.v_body_measurement");
  });

  it("filters body-fat rows before local-date deduplication when required", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(_schema, query, params) {
        calls.push({ query, params });
        return [];
      },
    };

    await fetchBodyWeightRows(store, "user-1", "America/New_York", "now", 90, {
      requireBodyFat: true,
    });

    const queryText = calls[0]?.query ?? "";
    expect(queryText).toMatch(
      /FROM analytics\.daily_body_measurement FINAL[\s\S]*AND body_fat_pct IS NOT NULL[\s\S]*\) AS body_rows[\s\S]*GROUP BY local_date/,
    );
  });

  it("uses the first scale reading of each local day for Trend Weight", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(_schema, query, params) {
        calls.push({ query, params });
        return [];
      },
    };

    await fetchBodyWeightRows(store, "user-1", "America/Los_Angeles", "2026-07-25", null);

    expect(calls[0]?.query).toContain(
      "argMin(weight_kg, (recorded_at, refresh_version, measurement_id))",
    );
    expect(calls[0]?.query).toContain(
      "argMin(body_fat_pct, (recorded_at, refresh_version, measurement_id))",
    );
  });
});

describe("fetchBodyCompRows", () => {
  it("casts recorded_at only after filtering by the native ClickHouse timestamp", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(_schema, query, params) {
        calls.push({ query, params });
        return [];
      },
    };

    await fetchBodyCompRows(store, "user-1", "now", 90);

    const queryText = calls[0]?.query ?? "";
    expect(queryText).toContain("toString(body_measurements.recorded_at) AS recorded_at");
    expect(queryText).toContain("AND recorded_at > subtractDays(now(), {days:UInt32})");
    expect(queryText).toContain("ORDER BY body_measurements.recorded_at ASC");
    expect(calls[0]?.params).toEqual({ userId: "user-1", endDate: "now", days: 90 });
  });
});

describe("fetchBodyComparisonRows", () => {
  it("treats now expressions as the open-ended comparison window", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(_schema, query, params) {
        calls.push({ query, params });
        return [];
      },
    };

    await fetchBodyComparisonRows(store, "user-1", "UTC", "2026-01-01", "now", 30);
    await fetchBodyComparisonRows(store, "user-1", "UTC", "2026-01-01", "NOW()", 30);

    for (const call of calls) {
      expect(call.query).toContain("AND local_date <= today()");
      expect(call.query).not.toContain("AND local_date <= toDate({endDate:String})");
    }
  });
});
