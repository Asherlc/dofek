import { describe, expect, it } from "vitest";
import {
  buildClickHouseTextFilterClauses,
  buildPostgresTextFilterConditions,
  buildPostgresTextFilterConditionsMapped,
  escapeLikePattern,
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

describe("buildPostgresTextFilterConditionsMapped", () => {
  it("maps API field names to DB columns", () => {
    const conditions = buildPostgresTextFilterConditionsMapped(
      { dataType: "activities", syncedAt: "2024" },
      { dataType: "data_type", syncedAt: "synced_at" },
    );
    expect(conditions).toHaveLength(2);
  });
});

describe("buildClickHouseTextFilterClauses", () => {
  it("builds parameterized filter clauses", () => {
    const result = buildClickHouseTextFilterClauses({ channel: "heart_rate" }, ["channel"]);
    expect(result.clause).toContain("positionCaseInsensitive");
    expect(result.params).toEqual({ filter_0: "heart_rate" });
  });

  it("returns empty clause when no valid filters", () => {
    expect(buildClickHouseTextFilterClauses({}, ["channel"])).toEqual({ clause: "", params: {} });
  });
});
