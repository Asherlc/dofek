import { describe, expect, it } from "vitest";
import {
  assertSqlColumnName,
  buildClickHouseFilterClauses,
  buildPostgresFilterConditions,
  buildPostgresFilterConditionsMapped,
  escapeLikePattern,
  fieldFiltersSchema,
} from "./field-filters.ts";

describe("assertSqlColumnName", () => {
  it("throws for invalid column names", () => {
    expect(() => assertSqlColumnName("bad-name")).toThrow("Invalid SQL column name");
    expect(() => assertSqlColumnName("1abc")).toThrow("Invalid SQL column name");
    expect(() => assertSqlColumnName("")).toThrow("Invalid SQL column name");
  });

  it("accepts valid column names", () => {
    expect(() => assertSqlColumnName("valid_column")).not.toThrow();
    expect(() => assertSqlColumnName("a")).not.toThrow();
  });
});

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLikePattern("100%_test\\")).toBe("100\\%\\_test\\\\");
  });
});

describe("buildPostgresFilterConditions", () => {
  it("ignores empty values and unknown columns", () => {
    const conditions = buildPostgresFilterConditions(
      { status: "  ", unknown: "x", canonical_type: "run" },
      ["canonical_type"],
    );
    expect(conditions).toHaveLength(1);
  });

  it("rejects invalid column names", () => {
    const conditions = buildPostgresFilterConditions({ "bad-name": "x" }, ["bad-name"]);
    expect(conditions).toHaveLength(0);
  });

  it("builds date range comparisons for date columns", () => {
    const conditions = buildPostgresFilterConditions(
      { date_from: "2024-06-01", date_to: "2024-06-30" },
      ["date"],
    );
    expect(conditions).toHaveLength(2);
  });

  it("normalizes datetime-local range values before building comparisons", () => {
    const input = "2024-06-01T08:30";
    const conditions = buildPostgresFilterConditions({ started_at_from: input }, ["started_at"]);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.queryChunks).toContain(new Date(input).toISOString());
  });

  it("does not normalize invalid datetime-local values (NaN date)", () => {
    expect(() =>
      buildPostgresFilterConditions({ started_at_from: "2024-13-01T08:30" }, ["started_at"]),
    ).not.toThrow();
  });

  it("skips range filters for non-range-filter columns", () => {
    const conditions = buildPostgresFilterConditions({ name_from: "2024-01-01" }, ["name"]);
    expect(conditions).toHaveLength(0);
  });

  it("rejects range filters when column is not in allowed set", () => {
    const conditions = buildPostgresFilterConditions({ date_from: "2024-01-01" }, ["other_column"]);
    expect(conditions).toHaveLength(0);
  });

  it("rejects range filters with invalid SQL column names", () => {
    const conditions = buildPostgresFilterConditions({ BadName_at_from: "2024-01-01" }, [
      "BadName_at",
    ]);
    expect(conditions).toHaveLength(0);
  });

  it("uses ::date cast for date column range conditions", () => {
    const conditions = buildPostgresFilterConditions(
      { date_from: "2024-06-01", date_to: "2024-06-30" },
      ["date"],
    );
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(JSON.stringify(condition)).toContain("::date");
    }
  });

  it("builds date range condition for only-to bound", () => {
    const conditions = buildPostgresFilterConditions({ date_to: "2024-06-30" }, ["date"]);
    expect(conditions).toHaveLength(1);
  });

  it("builds date range condition for only-from bound", () => {
    const conditions = buildPostgresFilterConditions({ date_from: "2024-06-01" }, ["date"]);
    expect(conditions).toHaveLength(1);
  });

  it("builds datetime range condition for only-to bound", () => {
    const conditions = buildPostgresFilterConditions({ started_at_to: "2024-06-30T18:00" }, [
      "started_at",
    ]);
    expect(conditions).toHaveLength(1);
  });

  it("does not create ILIKE conditions for range filter keys in text loop", () => {
    const conditions = buildPostgresFilterConditionsMapped(
      { date_from: "2024-06-01" },
      { date_from: "date_column" },
    );
    expect(conditions).toHaveLength(0);
  });

  it("does not create ILIKE for columns already used in range filters", () => {
    const conditions = buildPostgresFilterConditionsMapped(
      { syncedAt_from: "2024-06-01", syncedAt: "search_text" },
      { syncedAt: "synced_at" },
    );
    expect(conditions).toHaveLength(1);
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
    expect(result.params.recorded_at_from).toBe(new Date("2024-06-01T00:00").toISOString());
    expect(result.params.recorded_at_to).toBe(new Date("2024-06-30T23:59").toISOString());
  });

  it("leaves date-only range values unchanged", () => {
    const result = buildClickHouseFilterClauses(
      { date_from: "2024-06-01", date_to: "2024-06-30" },
      ["date"],
    );
    expect(result.params.date_from).toBe("2024-06-01");
    expect(result.params.date_to).toBe("2024-06-30");
  });

  it("does not normalize datetime-local values for date-only columns", () => {
    const result = buildClickHouseFilterClauses(
      { date_from: "2024-06-01T00:00", date_to: "2024-06-30T23:59" },
      ["date"],
    );
    expect(result.params.date_from).toBe("2024-06-01T00:00");
    expect(result.params.date_to).toBe("2024-06-30T23:59");
  });

  it("only normalizes values matching datetime-local format", () => {
    const result = buildClickHouseFilterClauses({ started_at_from: "2024-06-01" }, ["started_at"]);
    expect(result.params.started_at_from).toBe("2024-06-01");
  });

  it("returns empty clause when no valid filters", () => {
    expect(buildClickHouseFilterClauses({}, ["channel"])).toEqual({ clause: "", params: {} });
  });

  it("does not create text clauses for range filter keys in ClickHouse", () => {
    const result = buildClickHouseFilterClauses({ date_from: "2024-06-01" }, ["date_from"]);
    expect(result.clause).toBe("");
  });

  it("does not create text clauses for fields already in range bounds", () => {
    const result = buildClickHouseFilterClauses({ date_from: "2024-06-01", date: "search_value" }, [
      "date",
    ]);
    expect(result.clause).not.toContain("positionCaseInsensitive");
  });

  it("uses unique parameter names for multiple ClickHouse text filters", () => {
    const result = buildClickHouseFilterClauses({ channel: "heart_rate", source_name: "apple" }, [
      "channel",
      "source_name",
    ]);
    expect(result.params).toHaveProperty("filter_0");
    expect(result.params).toHaveProperty("filter_1");
  });

  it("builds ClickHouse range clause with only-to bound", () => {
    const result = buildClickHouseFilterClauses({ date_to: "2024-06-30" }, ["date"]);
    expect(result.clause).toContain("date <=");
    expect(result.clause).not.toContain("date >=");
  });

  it("builds ClickHouse range clause with only-from bound", () => {
    const result = buildClickHouseFilterClauses({ date_from: "2024-06-01" }, ["date"]);
    expect(result.clause).toContain("date >=");
    expect(result.clause).not.toContain("date <=");
  });

  it("uses Date type for date column bounds in ClickHouse", () => {
    const result = buildClickHouseFilterClauses(
      { date_from: "2024-06-01", date_to: "2024-06-30" },
      ["date"],
    );
    expect(result.clause).not.toContain("parseDateTimeBestEffort");
    expect(result.clause).toContain(":Date}");
  });

  it("uses parseDateTimeBestEffort for datetime column bounds in ClickHouse", () => {
    const result = buildClickHouseFilterClauses(
      { recorded_at_from: "2024-06-01T00:00", recorded_at_to: "2024-06-30T23:59" },
      ["recorded_at"],
    );
    expect(result.clause).toContain("parseDateTimeBestEffort");
    expect(result.clause).not.toContain(":Date}");
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
