import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clickHouseDateRangePredicate,
  clickHouseRangeLowerBound,
  clickHouseToIntervalDayLowerBound,
  currentDateRangePredicate,
  dateWindowEnd,
  dateWindowEndExclusiveString,
  dateWindowInput,
  dateWindowStart,
  dateWindowStartPredicate,
  dateWindowStartString,
  endDateSchema,
  postgresCurrentTimestampRangeLowerBound,
  postgresEndDateTimestampRangeLowerBound,
  rangeDaysInput,
  rangeDaysOrNullAdd,
  rangeDaysParams,
  selectedChartDateRangeInput,
  selectedChartRangeInput,
  selectedDateRangeInput,
  timestampWindowStart,
  timestampWindowStartPredicate,
  timestampWindowStartString,
} from "./date-window.ts";

const dialect = new PgDialect();

describe("dateWindowInput", () => {
  it("accepts valid endDate and days", () => {
    const result = dateWindowInput.parse({ endDate: "2026-03-23", days: 30 });
    expect(result).toEqual({ endDate: "2026-03-23", days: 30 });
  });

  it("defaults days to 30", () => {
    const result = dateWindowInput.parse({ endDate: "2026-03-23" });
    expect(result.days).toBe(30);
  });

  it("rejects invalid endDate format", () => {
    expect(() => dateWindowInput.parse({ endDate: "not-a-date" })).toThrow(z.ZodError);
    expect(() => dateWindowInput.parse({ endDate: "" })).toThrow(z.ZodError);
    expect(() => dateWindowInput.parse({ endDate: "2026/03/23" })).toThrow(z.ZodError);
  });

  it("defaults endDate to today when omitted", () => {
    const result = dateWindowInput.parse({ days: 7 });
    expect(result.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.days).toBe(7);
  });

  it("defaults both days and endDate when empty object", () => {
    const result = dateWindowInput.parse({});
    expect(result.days).toBe(30);
    expect(result.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects null days because generic date windows are finite-only", () => {
    expect(() => dateWindowInput.parse({ endDate: "2026-03-23", days: null })).toThrow(z.ZodError);
  });
});

describe("selectedDateRangeInput", () => {
  it("uses the caller-provided default while preserving null days", () => {
    const schema = selectedDateRangeInput(90);

    expect(schema.parse({ endDate: "2026-03-23" })).toEqual({
      endDate: "2026-03-23",
      days: 90,
    });
    expect(schema.parse({ endDate: "2026-03-23", days: null })).toEqual({
      endDate: "2026-03-23",
      days: null,
    });
  });
});

describe("rangeDaysInput", () => {
  it("defaults omitted days to the provided finite window", () => {
    expect(rangeDaysInput(90).parse({})).toEqual({ days: 90 });
  });

  it("preserves null days as an unbounded all-time range", () => {
    expect(rangeDaysInput(90).parse({ days: null })).toEqual({ days: null });
  });

  it("rejects non-positive finite days", () => {
    expect(() => rangeDaysInput(90).parse({ days: 0 })).toThrow(z.ZodError);
    expect(() => rangeDaysInput(90).parse({ days: -1 })).toThrow(z.ZodError);
  });
});

describe("selected chart range contracts", () => {
  it("builds endpoint-named days inputs from the central selected chart manifest", () => {
    expect(selectedChartRangeInput("power.powerCurve").parse({})).toEqual({ days: 90 });
    expect(selectedChartRangeInput("power.powerCurve").parse({ days: null })).toEqual({
      days: null,
    });
  });

  it("builds endpoint-named date range inputs from the central selected chart manifest", () => {
    expect(selectedChartDateRangeInput("sleep.list").parse({ endDate: "2026-03-23" })).toEqual({
      days: 30,
      endDate: "2026-03-23",
    });
    expect(
      selectedChartDateRangeInput("sleep.list").parse({
        days: null,
        endDate: "2026-03-23",
      }),
    ).toEqual({ days: null, endDate: "2026-03-23" });
  });
});

describe("rangeDaysParams", () => {
  it("includes days for finite ranges", () => {
    expect(rangeDaysParams(90)).toEqual({ days: 90 });
  });

  it("omits days for unbounded ranges", () => {
    expect(rangeDaysParams(null)).toEqual({});
  });
});

describe("rangeDaysOrNullAdd", () => {
  it("adds warmup days only to finite ranges", () => {
    expect(rangeDaysOrNullAdd(30, 60)).toBe(90);
    expect(rangeDaysOrNullAdd(null, 60)).toBeNull();
  });
});

describe("range lower-bound predicates", () => {
  it("builds a Postgres current timestamp predicate for finite ranges", () => {
    const compiledQuery = dialect.sqlToQuery(
      postgresCurrentTimestampRangeLowerBound(30, sql`started_at`),
    );

    expect(compiledQuery.sql).toBe(
      "AND started_at > CURRENT_TIMESTAMP - $1::int * INTERVAL '1 day'",
    );
    expect(compiledQuery.params).toEqual([30]);
  });

  it("omits the Postgres current timestamp predicate for unbounded ranges", () => {
    const compiledQuery = dialect.sqlToQuery(
      postgresCurrentTimestampRangeLowerBound(null, sql`started_at`),
    );

    expect(compiledQuery.sql).toBe("");
    expect(compiledQuery.params).toEqual([]);
  });

  it("builds a timestamp window predicate for finite endDate ranges", () => {
    const compiledQuery = dialect.sqlToQuery(
      postgresEndDateTimestampRangeLowerBound(7, sql`activity.started_at`, "2026-03-23"),
    );

    expect(compiledQuery.sql).toBe("AND activity.started_at > ($1::date - $2::int)::timestamp");
    expect(compiledQuery.params).toEqual(["2026-03-23", 7]);
  });

  it("omits the timestamp window predicate for unbounded endDate ranges", () => {
    const compiledQuery = dialect.sqlToQuery(
      postgresEndDateTimestampRangeLowerBound(null, sql`activity.started_at`, "2026-03-23"),
    );

    expect(compiledQuery.sql).toBe("");
    expect(compiledQuery.params).toEqual([]);
  });

  it("builds date-window predicates for finite endDate ranges", () => {
    const compiledQuery = dialect.sqlToQuery(
      dateWindowStartPredicate(sql`metrics.date`, "2026-03-23", 30, ">="),
    );

    expect(compiledQuery.sql).toBe("AND metrics.date >= $1::date - $2::int");
    expect(compiledQuery.params).toEqual(["2026-03-23", 30]);
  });

  it("omits date-window predicates for unbounded endDate ranges", () => {
    const compiledQuery = dialect.sqlToQuery(
      dateWindowStartPredicate(sql`metrics.date`, "2026-03-23", null),
    );

    expect(compiledQuery.sql).toBe("");
    expect(compiledQuery.params).toEqual([]);
  });

  it("builds timestamp predicates for finite endDate ranges and omits them for unbounded ranges", () => {
    const finiteQuery = dialect.sqlToQuery(
      timestampWindowStartPredicate(sql`activity.started_at`, "2026-03-23", 7),
    );
    const unboundedQuery = dialect.sqlToQuery(
      timestampWindowStartPredicate(sql`activity.started_at`, "2026-03-23", null),
    );

    expect(finiteQuery.sql).toBe("AND activity.started_at > ($1::date - $2::int)::timestamp");
    expect(finiteQuery.params).toEqual(["2026-03-23", 7]);
    expect(unboundedQuery.sql).toBe("");
    expect(unboundedQuery.params).toEqual([]);
  });

  it("builds current-date predicates for finite ranges and omits them for unbounded ranges", () => {
    const finiteQuery = dialect.sqlToQuery(currentDateRangePredicate(sql`food.date`, 30, ">="));
    const unboundedQuery = dialect.sqlToQuery(currentDateRangePredicate(sql`food.date`, null));

    expect(finiteQuery.sql).toBe("AND food.date >= (CURRENT_DATE - $1::int)");
    expect(finiteQuery.params).toEqual([30]);
    expect(unboundedQuery.sql).toBe("");
    expect(unboundedQuery.params).toEqual([]);
  });

  it("builds ClickHouse INTERVAL DAY predicates for finite ranges", () => {
    expect(clickHouseRangeLowerBound(90, "activity.started_at")).toBe(
      "AND activity.started_at > now() - INTERVAL {days:Int32} DAY",
    );
  });

  it("builds ClickHouse toIntervalDay predicates for finite ranges", () => {
    expect(clickHouseToIntervalDayLowerBound(90, "activity.started_at")).toBe(
      "AND activity.started_at > now() - toIntervalDay({days:UInt32})",
    );
  });

  it("omits ClickHouse predicates for unbounded ranges", () => {
    expect(clickHouseRangeLowerBound(null, "activity.started_at")).toBe("");
    expect(clickHouseToIntervalDayLowerBound(null, "activity.started_at")).toBe("");
  });

  it("builds ClickHouse selected-date predicates for finite ranges and omits them for unbounded ranges", () => {
    expect(
      clickHouseDateRangePredicate({
        expression: "sleep.date",
        days: 30,
        operator: ">=",
      }),
    ).toBe("AND sleep.date >= subtractDays(toDate({endDate:String}), {days:UInt32})");
    expect(
      clickHouseDateRangePredicate({
        expression: "sleep.date",
        days: null,
      }),
    ).toBe("");
  });
});

describe("endDateSchema", () => {
  it("transforms undefined to today's date", () => {
    const result = endDateSchema.parse(undefined);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Verify it looks like a real date
    const parsed = new Date(result);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("passes through a valid YYYY-MM-DD date", () => {
    const result = endDateSchema.parse("2026-01-15");
    expect(result).toBe("2026-01-15");
  });

  it("rejects date with wrong separators", () => {
    expect(() => endDateSchema.parse("2026/01/15")).toThrow(z.ZodError);
  });

  it("rejects partial date", () => {
    expect(() => endDateSchema.parse("2026-01")).toThrow(z.ZodError);
  });

  it("rejects empty string", () => {
    expect(() => endDateSchema.parse("")).toThrow(z.ZodError);
  });

  it("rejects non-numeric segments", () => {
    expect(() => endDateSchema.parse("abcd-ef-gh")).toThrow(z.ZodError);
  });

  it("rejects impossible calendar dates", () => {
    expect(() => endDateSchema.parse("2026-02-29")).toThrow(z.ZodError);
  });
});

describe("dateWindowStart", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = dateWindowStart("2026-03-23", 30);
    expect(result.queryChunks).toBeDefined();
  });

  it("produces different SQL for different endDates", () => {
    const windowA = dateWindowStart("2026-03-23", 30);
    const windowB = dateWindowStart("2026-01-01", 30);
    expect(windowA).not.toEqual(windowB);
  });

  it("produces different SQL for different days values", () => {
    const windowA = dateWindowStart("2026-03-23", 30);
    const windowB = dateWindowStart("2026-03-23", 7);
    expect(windowA).not.toEqual(windowB);
  });

  it("embeds both endDate and days in query chunks", () => {
    const result = dateWindowStart("2026-03-23", 30);
    // The SQL template should contain both values
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("2026-03-23");
    expect(chunks).toContain("30");
  });
});

describe("dateWindowEnd", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = dateWindowEnd("2026-03-23");
    expect(result.queryChunks).toBeDefined();
  });

  it("produces different SQL for different endDates", () => {
    const windowA = dateWindowEnd("2026-03-23");
    const windowB = dateWindowEnd("2026-01-01");
    expect(windowA).not.toEqual(windowB);
  });

  it("embeds the endDate in query chunks", () => {
    const result = dateWindowEnd("2026-06-15");
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("2026-06-15");
  });
});

describe("dateWindowStartString", () => {
  it("returns a YYYY-MM-DD lower bound for non-SQL query parameters", () => {
    expect(dateWindowStartString("2026-03-23", 30)).toBe("2026-02-21");
  });
});

describe("dateWindowEndExclusiveString", () => {
  it("returns the day after the inclusive end date", () => {
    expect(dateWindowEndExclusiveString("2026-03-23")).toBe("2026-03-24");
  });
});

describe("timestampWindowStart", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = timestampWindowStart("2026-03-23", 7);
    expect(result.queryChunks).toBeDefined();
  });

  it("produces different SQL for different endDates", () => {
    const windowA = timestampWindowStart("2026-03-23", 7);
    const windowB = timestampWindowStart("2026-01-01", 7);
    expect(windowA).not.toEqual(windowB);
  });

  it("produces different SQL for different days values", () => {
    const windowA = timestampWindowStart("2026-03-23", 7);
    const windowB = timestampWindowStart("2026-03-23", 30);
    expect(windowA).not.toEqual(windowB);
  });

  it("embeds both endDate and days in query chunks", () => {
    const result = timestampWindowStart("2026-03-23", 14);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("2026-03-23");
    expect(chunks).toContain("14");
  });

  it("produces different result from dateWindowStart for same inputs", () => {
    const timestamp = timestampWindowStart("2026-03-23", 7);
    const dateStart = dateWindowStart("2026-03-23", 7);
    // They use different SQL casts (::timestamp vs just ::date - ::int)
    expect(timestamp).not.toEqual(dateStart);
  });
});

describe("timestampWindowStartString", () => {
  it("returns a midnight timestamp lower bound for non-SQL query parameters", () => {
    expect(timestampWindowStartString("2026-03-23", 7)).toBe("2026-03-16 00:00:00");
  });
});
