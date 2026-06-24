import { describe, expect, it } from "vitest";
import {
  buildClickHouseFilterClauses,
  buildPostgresFilterConditions,
  buildPostgresFilterConditionsMapped,
  buildPostgresTextFilterConditions,
  buildPostgresTextFilterConditionsMapped,
  escapeLikePattern,
  fieldFiltersSchema,
  parseRangeFilterKey,
} from "./field-filters.ts";

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLikePattern("100%_test\\")).toBe("100\\%\\_test\\\\");
  });
});

describe("buildPostgresTextFilterConditions", () => {
  it("ignores empty values and unknown columns", () => {
    const conditions = buildPostgresTextFilterConditions(
      { status: "  ", unknown: "x", activity_type: "run" },
      ["activity_type"],
    );
    expect(conditions).toHaveLength(1);
  });

  it("rejects invalid column names", () => {
    const conditions = buildPostgresTextFilterConditions({ "bad-name": "x" }, ["bad-name"]);
    expect(conditions).toHaveLength(0);
  });
});

describe("buildPostgresFilterConditionsMapped", () => {
  it("maps API field names to DB columns", () => {
    const conditions = buildPostgresFilterConditionsMapped(
      { dataType: "activities", syncedAt: "2024" },
      { dataType: "data_type", syncedAt: "synced_at" },
    );
    expect(conditions).toHaveLength(2);
  });

  it("builds datetime range comparisons for mapped API keys", () => {
    const conditions = buildPostgresFilterConditionsMapped(
      {
        syncedAt_from: "2024-06-01T00:00",
        syncedAt_to: "2024-06-30T23:59",
      },
      { syncedAt: "synced_at" },
    );
    expect(conditions).toHaveLength(2);
  });
});

describe("buildPostgresFilterConditions", () => {
  it("builds date range comparisons for date columns", () => {
    const conditions = buildPostgresFilterConditions(
      { date_from: "2024-06-01", date_to: "2024-06-30" },
      ["date"],
    );
    expect(conditions).toHaveLength(2);
  });
});

describe("parseRangeFilterKey", () => {
  it("parses from/to suffixes", () => {
    expect(parseRangeFilterKey("started_at_from")).toEqual({
      column: "started_at",
      bound: "from",
    });
    expect(parseRangeFilterKey("syncedAt_to")).toEqual({
      column: "syncedAt",
      bound: "to",
    });
    expect(parseRangeFilterKey("status")).toBeNull();
  });
});

describe("buildClickHouseFilterClauses", () => {
  it("builds parameterized filter clauses", () => {
    const result = buildClickHouseFilterClauses({ channel: "heart_rate" }, ["channel"]);
    expect(result.clause).toContain("positionCaseInsensitive");
    expect(result.params).toEqual({ filter_0: "heart_rate" });
  });

  it("builds datetime range clauses", () => {
    const result = buildClickHouseFilterClauses(
      {
        recorded_at_from: "2024-06-01T00:00",
        recorded_at_to: "2024-06-30T23:59",
      },
      ["recorded_at"],
    );
    expect(result.clause).toContain("recorded_at >=");
    expect(result.clause).toContain("recorded_at <=");
    expect(result.params.recorded_at_from).toBe("2024-06-01T00:00");
  });

  it("returns empty clause when no valid filters", () => {
    expect(buildClickHouseFilterClauses({}, ["channel"])).toEqual({ clause: "", params: {} });
  });
});

describe("fieldFiltersSchema", () => {
  it("rejects too many filters", () => {
    const filters = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [`field_${index}`, "value"]),
    );
    expect(fieldFiltersSchema.safeParse(filters).success).toBe(false);
  });

  it("rejects invalid filter field names", () => {
    expect(fieldFiltersSchema.safeParse({ "bad-name": "x" }).success).toBe(false);
  });
});
