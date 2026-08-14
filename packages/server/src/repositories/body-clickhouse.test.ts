import { describe, expect, it } from "vitest";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import {
  fetchBodyComparisonRows,
  fetchBodyCompProvenanceRows,
  fetchBodyCompRows,
  fetchBodyDecisionMeasurements,
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

describe("fetchBodyDecisionMeasurements", () => {
  it("returns provider, source, and timestamp for positive body measurements", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(schema, query, params) {
        calls.push({ query, params });
        return [
          schema.parse({
            date: "2026-07-25",
            recorded_at: "2026-07-25T08:00:00.000Z",
            recorded_at_local: "2026-07-25 08:00:00",
            weight_kg: 72,
            provider_id: "withings",
            source_name: "Body+",
          }),
        ];
      },
    };

    await expect(
      fetchBodyDecisionMeasurements(store, "user-1", "America/Los_Angeles", "now"),
    ).resolves.toEqual([
      {
        date: "2026-07-25",
        recorded_at: "2026-07-25T08:00:00.000Z",
        recorded_at_local: "2026-07-25 08:00:00",
        weight_kg: 72,
        provider_id: "withings",
        source_name: "Body+",
      },
    ]);
    expect(calls[0]?.query).toContain("FROM analytics.v_body_measurement");
    expect(calls[0]?.query).toContain("weight_kg > 0");
    expect(calls[0]?.query).toContain("provider_id");
    expect(calls[0]?.query).toContain("recorded_at_local");
    expect(calls[0]?.query).toContain(
      "formatDateTime(body_measurement.recorded_at, '%Y-%m-%d %H:%i:%S', {timezone:String}) AS recorded_at_local",
    );
    expect(calls[0]?.query).toContain(
      "toDate(toTimeZone(body_measurement.recorded_at, {timezone:String})) <= toDate(toTimeZone(now(), {timezone:String}))",
    );
    expect(calls[0]?.query).toContain("FROM analytics.v_body_measurement AS body_measurement");
    expect(calls[0]?.params).toMatchObject({ userId: "user-1", timezone: "America/Los_Angeles" });
  });

  it("applies limited access to the measurement's computed local date", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(_schema, query, params) {
        calls.push({ query, params });
        return [];
      },
    };

    await fetchBodyDecisionMeasurements(store, "user-1", "UTC", "2026-07-25", {
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-20",
      endDateExclusive: "2026-07-27",
    });

    const queryText = calls[0]?.query ?? "";
    expect(queryText).toContain(
      "AND toDate(toTimeZone(body_measurement.recorded_at, {timezone:String})) >= toDate({accessStart:String})",
    );
    expect(queryText).toContain(
      "AND toDate(toTimeZone(body_measurement.recorded_at, {timezone:String})) < toDate({accessEnd:String})",
    );
    expect(queryText).not.toContain("AND local_date >=");
    expect(calls[0]?.params).toMatchObject({
      accessStart: "2026-07-20",
      accessEnd: "2026-07-27",
    });
  });
});

describe("fetchBodyCompRows", () => {
  it("keeps provenance fields separate from the generic insight row contract", async () => {
    const store: BodyClickHouseStore = {
      async query(schema) {
        return [
          schema.parse({
            date: "2026-07-25",
            recorded_at: "2026-07-25T08:00:00.000Z",
            provider_id: "withings",
            source_providers: ["apple_health"],
            weight_kg: 72,
            body_fat_pct: 18,
          }),
        ];
      },
    };

    await expect(fetchBodyCompRows(store, "user-1", "UTC", "now", 90)).resolves.toEqual([
      {
        date: "2026-07-25",
        recorded_at: "2026-07-25T08:00:00.000Z",
        weight_kg: 72,
        body_fat_pct: 18,
      },
    ]);
    await expect(fetchBodyCompProvenanceRows(store, "user-1", "UTC", "now", 90)).resolves.toEqual([
      {
        date: "2026-07-25",
        recorded_at: "2026-07-25T08:00:00.000Z",
        provider_id: "withings",
        source_providers: ["apple_health"],
        weight_kg: 72,
        body_fat_pct: 18,
      },
    ]);
  });

  it("returns and filters by the user's local calendar date", async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const store: BodyClickHouseStore = {
      async query(_schema, query, params) {
        calls.push({ query, params });
        return [];
      },
    };

    await fetchBodyCompRows(store, "user-1", "America/Los_Angeles", "now", 90);

    const queryText = calls[0]?.query ?? "";
    expect(queryText).toContain(
      "toString(toDate(toTimeZone(body_measurements.recorded_at, {timezone:String}))) AS date",
    );
    expect(queryText).toContain(
      "formatDateTime(body_measurements.recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at",
    );
    expect(queryText).toContain(
      "AND toDate(toTimeZone(recorded_at, {timezone:String})) <= toDate(toTimeZone(now(), {timezone:String}))",
    );
    expect(queryText).toContain(
      "AND toDate(toTimeZone(recorded_at, {timezone:String})) > subtractDays(toDate(toTimeZone(now(), {timezone:String})), {days:UInt32})",
    );
    expect(queryText).toContain("ORDER BY body_measurements.recorded_at ASC");
    expect(calls[0]?.params).toEqual({
      userId: "user-1",
      timezone: "America/Los_Angeles",
      endDate: "now",
      days: 90,
    });
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
