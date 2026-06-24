import { describe, expect, it } from "vitest";
import {
  filterRangeBoundKey,
  formatFilterOptionLabel,
  getFilterInputType,
  toFilterOptions,
} from "./provider-detail-filter-options.ts";

describe("formatFilterOptionLabel", () => {
  it("formats activity types with training labels", () => {
    expect(formatFilterOptionLabel("activity_type", "road_cycling")).toBe("Road Cycling");
  });

  it("formats snake_case values for other columns", () => {
    expect(formatFilterOptionLabel("status", "access_token_expired")).toBe("Access Token Expired");
  });
});

describe("getFilterInputType", () => {
  it("uses date pickers for date-only columns", () => {
    expect(getFilterInputType("date")).toBe("date");
    expect(getFilterInputType("start_date")).toBe("date");
    expect(getFilterInputType("end_date")).toBe("date");
  });

  it("uses datetime pickers for timestamp columns", () => {
    expect(getFilterInputType("syncedAt")).toBe("datetime-local");
    expect(getFilterInputType("started_at")).toBe("datetime-local");
    expect(getFilterInputType("created_at")).toBe("datetime-local");
    expect(getFilterInputType("logged_at")).toBe("datetime-local");
  });

  it("uses text inputs for other columns", () => {
    expect(getFilterInputType("status")).toBe("text");
    expect(getFilterInputType("name")).toBe("text");
  });
});

describe("filterRangeBoundKey", () => {
  it("builds from/to filter keys", () => {
    expect(filterRangeBoundKey("started_at", "from")).toBe("started_at_from");
    expect(filterRangeBoundKey("syncedAt", "to")).toBe("syncedAt_to");
  });
});

describe("toFilterOptions", () => {
  it("maps API options to labeled dropdown entries", () => {
    expect(
      toFilterOptions("meal", [{ value: "breakfast" }, { value: "dinner", label: "Dinner" }]),
    ).toEqual([
      { value: "breakfast", label: "Breakfast" },
      { value: "dinner", label: "Dinner" },
    ]);
  });

  it("returns undefined when no options are available", () => {
    expect(toFilterOptions("status", undefined)).toBeUndefined();
  });
});
