import { describe, expect, it } from "vitest";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import { fetchBodyCompRows } from "./body-clickhouse.ts";

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
