import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestCallerFactory } from "../routers/test-helpers.ts";
import { router } from "../trpc.ts";
import {
  ChartRange,
  selectedChartCustomRangeQuery,
  selectedChartDateRangeQuery,
  selectedChartRangeQuery,
  selectedChartRangeSchema,
} from "./chart-range.ts";

const dialect = new PgDialect();
const cacheSetCalls = vi.hoisted((): Array<{ key: string; data: unknown; ttlMs: number }> => []);

vi.mock("dofek/lib/cache", () => ({
  queryCache: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(async (key: string, data: unknown, ttlMs: number) => {
      cacheSetCalls.push({ key, data, ttlMs });
    }),
    invalidateByPrefix: vi.fn(),
    invalidateAll: vi.fn(),
  },
}));

describe("ChartRange", () => {
  it("models finite and all-history selected chart ranges as a value object", () => {
    const finiteRange = ChartRange.fromDays(30);
    const allRange = ChartRange.fromDays(null);

    expect(finiteRange.days).toBe(30);
    expect(finiteRange.isAll()).toBe(false);
    expect(allRange.days).toBeNull();
    expect(allRange.isAll()).toBe(true);
  });

  it("keeps lower-bound predicates and params coupled", () => {
    const finiteRange = ChartRange.fromDays(30);
    const allRange = ChartRange.fromDays(null);

    expect(finiteRange.clickHouseTimestampAfter("activity.started_at")).toBe(
      "AND activity.started_at > now() - INTERVAL {days:Int32} DAY",
    );
    expect(finiteRange.clickHouseTimestampAfterToIntervalDay("activity.started_at")).toBe(
      "AND activity.started_at > now() - toIntervalDay({days:UInt32})",
    );
    expect(
      finiteRange.clickHouseTimestampAfterToIntervalDay("activity.started_at", "windowDays"),
    ).toBe("AND activity.started_at > now() - toIntervalDay({windowDays:UInt32})");
    expect(finiteRange.clickHouseDateAfterToday("activity.date")).toBe(
      "AND activity.date > today() - INTERVAL {days:Int32} DAY",
    );
    expect(finiteRange.clickHouseDateAfterToday("activity.date", "windowDays")).toBe(
      "AND activity.date > today() - INTERVAL {windowDays:Int32} DAY",
    );
    expect(finiteRange.clickHouseMondayAfterToday("activity.week")).toBe(
      "AND activity.week > toMonday(today() - INTERVAL {days:Int32} DAY)",
    );
    expect(finiteRange.clickHouseMondayAfterToday("activity.week", "windowDays", ">=")).toBe(
      "AND activity.week >= toMonday(today() - INTERVAL {windowDays:Int32} DAY)",
    );
    expect(finiteRange.clickHouseParams()).toEqual({ days: 30 });
    expect(allRange.clickHouseTimestampAfter("activity.started_at")).toBe("");
    expect(allRange.clickHouseTimestampAfterToIntervalDay("activity.started_at")).toBe("");
    expect(allRange.clickHouseDateAfterToday("activity.date")).toBe("");
    expect(allRange.clickHouseMondayAfterToday("activity.week")).toBe("");
    expect(allRange.clickHouseParams()).toEqual({});
  });

  it("adds warmup days only to finite ranges", () => {
    expect(ChartRange.fromDays(30).withWarmupDays(7).days).toBe(37);
    expect(ChartRange.fromDays(null).withWarmupDays(7).days).toBeNull();
  });

  it("builds Postgres predicates without exposing raw nullable days", () => {
    const finiteQuery = dialect.sqlToQuery(
      ChartRange.fromDays(30).postgresTimestampAfterNow(sql`a.started_at`),
    );
    const allQuery = dialect.sqlToQuery(
      ChartRange.fromDays(null).postgresTimestampAfterNow(sql`a.started_at`),
    );

    expect(finiteQuery.sql).toBe(
      "AND a.started_at > CURRENT_TIMESTAMP - $1::int * INTERVAL '1 day'",
    );
    expect(finiteQuery.params).toEqual([30]);
    expect(allQuery.sql).toBe("");
    expect(allQuery.params).toEqual([]);
  });

  it("builds Postgres current timestamp predicates for finite and all ranges", () => {
    const finiteQuery = dialect.sqlToQuery(
      ChartRange.fromDays(30).postgresTimestampAfterCurrentTimestamp(sql`a.started_at`),
    );
    const allQuery = dialect.sqlToQuery(
      ChartRange.fromDays(null).postgresTimestampAfterCurrentTimestamp(sql`a.started_at`),
    );

    expect(finiteQuery.sql).toBe(
      "AND a.started_at > CURRENT_TIMESTAMP - $1::int * INTERVAL '1 day'",
    );
    expect(finiteQuery.params).toEqual([30]);
    expect(allQuery.sql).toBe("");
    expect(allQuery.params).toEqual([]);
  });

  it("builds end-date Postgres predicates for timestamps and dates", () => {
    const range = ChartRange.fromDays(7);
    const allRange = ChartRange.fromDays(null);

    const timestampQuery = dialect.sqlToQuery(
      range.postgresTimestampAfterEndDate(sql`activity.started_at`, "2026-03-23"),
    );
    const exclusiveDateQuery = dialect.sqlToQuery(
      range.postgresDateAfterEndDate(sql`metrics.date`, "2026-03-23"),
    );
    const inclusiveDateQuery = dialect.sqlToQuery(
      range.postgresDateAfterEndDate(sql`metrics.date`, "2026-03-23", ">="),
    );

    expect(timestampQuery.sql).toBe("AND activity.started_at > ($1::date - $2::int)::timestamp");
    expect(timestampQuery.params).toEqual(["2026-03-23", 7]);
    expect(exclusiveDateQuery.sql).toBe("AND metrics.date > $1::date - $2::int");
    expect(exclusiveDateQuery.params).toEqual(["2026-03-23", 7]);
    expect(inclusiveDateQuery.sql).toBe("AND metrics.date >= $1::date - $2::int");
    expect(inclusiveDateQuery.params).toEqual(["2026-03-23", 7]);
    expect(
      dialect.sqlToQuery(
        allRange.postgresTimestampAfterEndDate(sql`activity.started_at`, "2026-03-23"),
      ).sql,
    ).toBe("");
    expect(
      dialect.sqlToQuery(allRange.postgresDateAfterEndDate(sql`metrics.date`, "2026-03-23")).sql,
    ).toBe("");
  });

  it("builds current-date Postgres predicates for both range operators", () => {
    const range = ChartRange.fromDays(14);
    const exclusiveQuery = dialect.sqlToQuery(range.currentDateAfter(sql`food.date`));
    const inclusiveQuery = dialect.sqlToQuery(range.currentDateAfter(sql`food.date`, ">="));
    const allQuery = dialect.sqlToQuery(ChartRange.fromDays(null).currentDateAfter(sql`food.date`));

    expect(exclusiveQuery.sql).toBe("AND food.date > CURRENT_DATE - $1::int");
    expect(exclusiveQuery.params).toEqual([14]);
    expect(inclusiveQuery.sql).toBe("AND food.date >= (CURRENT_DATE - $1::int)");
    expect(inclusiveQuery.params).toEqual([14]);
    expect(allQuery.sql).toBe("");
    expect(allQuery.params).toEqual([]);
  });

  it("builds ClickHouse date predicates from explicit window start params", () => {
    const finiteRange = ChartRange.fromDays(30);
    const allRange = ChartRange.fromDays(null);

    expect(finiteRange.clickHouseDateAfterWindowStart({ expression: "strain.date" })).toBe(
      "AND strain.date > toDate({windowStart:String})",
    );
    expect(
      finiteRange.clickHouseDateAfterWindowStart({
        expression: "strain.date",
        operator: ">=",
        paramName: "outputWindowStart",
      }),
    ).toBe("AND strain.date >= toDate({outputWindowStart:String})");
    expect(allRange.clickHouseDateAfterWindowStart({ expression: "strain.date" })).toBe("");
  });

  it("builds ClickHouse date predicates from end-date expressions", () => {
    const range = ChartRange.fromDays(30);
    const allRange = ChartRange.fromDays(null);

    expect(range.clickHouseDateAfterEndDate({ expression: "strain.date" })).toBe(
      "AND strain.date > subtractDays(toDate({endDate:String}), {days:UInt32})",
    );
    expect(
      range.clickHouseDateAfterEndDate({
        expression: "strain.date",
        operator: ">=",
        endDateExpression: "max(strain.date)",
      }),
    ).toBe("AND strain.date >= subtractDays(max(strain.date), {days:UInt32})");
    expect(allRange.clickHouseDateAfterEndDate({ expression: "strain.date" })).toBe("");
  });
});

describe("selected chart range query builders", () => {
  beforeEach(() => {
    cacheSetCalls.length = 0;
  });

  it("injects ChartRange into days-only selected chart handlers", async () => {
    const testRouter = router({
      powerCurve: selectedChartRangeQuery("power.powerCurve", 1, ({ range }) => ({
        days: range.days,
        all: range.isAll(),
      })),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.powerCurve({ days: null })).resolves.toEqual({
      days: null,
      all: true,
    });
    await expect(caller.powerCurve({})).resolves.toEqual({ days: 90, all: false });
    expect(cacheSetCalls.at(-1)?.ttlMs).toBe(1);
  });

  it("validates days-only selected chart outputs", async () => {
    const testRouter = router({
      powerCurve: selectedChartRangeQuery(
        "power.powerCurve",
        1,
        ({ range }) => ({ days: range.days }),
        { outputSchema: z.object({ days: z.number() }) },
      ),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.powerCurve({ days: null })).rejects.toThrow();
  });

  it("versions cached days-only responses when their output contract changes", async () => {
    const testRouter = router({
      powerCurve: selectedChartRangeQuery(
        "power.powerCurve",
        1,
        ({ range }) => ({ days: range.days }),
        { keyVersion: "estimated-max-trend-v1" },
      ),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await caller.powerCurve({ days: 30 });

    expect(cacheSetCalls.at(-1)?.key).toContain(":estimated-max-trend-v1:");
  });

  it("injects ChartRange into date-window selected chart handlers", async () => {
    const testRouter = router({
      sleepList: selectedChartDateRangeQuery("sleep.list", 1, ({ input, range }) => ({
        days: range.days,
        endDate: input.endDate,
      })),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.sleepList({ days: null, endDate: "2026-07-09" })).resolves.toEqual({
      days: null,
      endDate: "2026-07-09",
    });
    expect(cacheSetCalls.at(-1)?.ttlMs).toBe(1);
  });

  it("versions cached date-window responses when their output contract changes", async () => {
    const testRouter = router({
      sleepList: selectedChartDateRangeQuery(
        "sleep.list",
        1,
        ({ input, range }) => ({
          days: range.days,
          endDate: input.endDate,
        }),
        { keyVersion: "health-status-evidence-v1" },
      ),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await caller.sleepList({ days: 30, endDate: "2026-07-09" });

    expect(cacheSetCalls.at(-1)?.key).toContain(":health-status-evidence-v1:");
  });

  it("injects ChartRange into selected chart handlers with custom inputs", async () => {
    const testRouter = router({
      activityVariability: selectedChartCustomRangeQuery(
        "cyclingAdvanced.activityVariability",
        1,
        z.object({
          days: selectedChartRangeSchema("cyclingAdvanced.activityVariability"),
          limit: z.number().default(20),
        }),
        ({ input, range }) => ({ days: range.days, limit: input.limit }),
      ),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.activityVariability({ days: null })).resolves.toEqual({
      days: null,
      limit: 20,
    });
    expect(cacheSetCalls.at(-1)?.ttlMs).toBe(1);
  });

  it("versions cached custom-range responses when their output contract changes", async () => {
    const testRouter = router({
      activityVariability: selectedChartCustomRangeQuery(
        "cyclingAdvanced.activityVariability",
        1,
        z.object({
          days: selectedChartRangeSchema("cyclingAdvanced.activityVariability"),
        }),
        ({ input, range }) => ({ days: range.days, inputDays: input.days }),
        z.object({ days: z.number().nullable(), inputDays: z.number().nullable() }),
        { keyVersion: "activity-states-v1" },
      ),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await caller.activityVariability({ days: null });

    expect(cacheSetCalls.at(-1)?.key).toContain(":activity-states-v1:");
  });

  it("rejects custom selected chart handlers without input", async () => {
    const testRouter = router({
      activityVariability: selectedChartCustomRangeQuery(
        "cyclingAdvanced.activityVariability",
        1,
        z.custom<{ days: 30 | null }>(() => true),
        ({ input, range }) => ({ days: range.days, inputDays: input.days }),
      ),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.activityVariability(undefined)).rejects.toThrow(
      "cyclingAdvanced.activityVariability selected chart range input is required",
    );
  });

  it("rejects a builder that does not match the endpoint contract", () => {
    expect(() =>
      selectedChartRangeQuery("sleep.list", 1, ({ range }) => ({
        days: range.days,
      })),
    ).toThrow("sleep.list must use dateRange selected chart range input");
  });

  it("keeps finite range constraints inside the route builder", async () => {
    const testRouter = router({
      impactSummary: selectedChartRangeQuery(
        "behaviorImpact.impactSummary",
        1,
        ({ range }) => ({
          days: range.days,
        }),
        { min: 7, max: 365 },
      ),
    });
    const caller = createTestCallerFactory(testRouter)({
      db: {},
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.impactSummary({ days: 6 })).rejects.toThrow();
    await expect(caller.impactSummary({ days: 366 })).rejects.toThrow();
    await expect(caller.impactSummary({ days: null })).resolves.toEqual({ days: null });
  });
});
