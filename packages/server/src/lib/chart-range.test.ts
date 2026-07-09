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
    expect(finiteRange.clickHouseParams()).toEqual({ days: 30 });
    expect(allRange.clickHouseTimestampAfter("activity.started_at")).toBe("");
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

    expect(finiteQuery.sql).toBe("AND a.started_at > NOW() - $1::int * INTERVAL '1 day'");
    expect(finiteQuery.params).toEqual([30]);
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
