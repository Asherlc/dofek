import { describe, expect, it } from "vitest";
import {
  getFilterInputType,
  isDateFilterColumn,
  isDateTimeFilterColumn,
  isRangeFilterColumn,
  parseRangeFilterKey,
} from "./index.ts";

describe("isDateFilterColumn", () => {
  it("identifies date-only columns", () => {
    expect(isDateFilterColumn("date")).toBe(true);
    expect(isDateFilterColumn("start_date")).toBe(true);
    expect(isDateFilterColumn("end_date")).toBe(true);
    expect(isDateFilterColumn("started_at")).toBe(false);
  });
});

describe("isDateTimeFilterColumn", () => {
  it("identifies timestamp columns", () => {
    expect(isDateTimeFilterColumn("syncedAt")).toBe(true);
    expect(isDateTimeFilterColumn("synced_at")).toBe(true);
    expect(isDateTimeFilterColumn("started_at")).toBe(true);
    expect(isDateTimeFilterColumn("date")).toBe(false);
  });
});

describe("isRangeFilterColumn", () => {
  it("includes date and datetime columns", () => {
    expect(isRangeFilterColumn("date")).toBe(true);
    expect(isRangeFilterColumn("started_at")).toBe(true);
    expect(isRangeFilterColumn("status")).toBe(false);
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
