import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { refreshDedupViews } from "../db/dedup.ts";
import { loadProviderPriorityConfig, syncProviderPriorities } from "../db/provider-priority.ts";
import { DEFAULT_USER_ID, dailyMetrics, sleepSession } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider } from "../db/tokens.ts";
import { fitSleepFromDb } from "./refit.ts";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  await ensureProvider(ctx.db, "test-provider", "Test Provider");
  const priorityConfig = loadProviderPriorityConfig();
  if (priorityConfig) {
    await syncProviderPriorities(ctx.db, priorityConfig);
  }
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
});

beforeEach(async () => {
  await ctx.db.delete(sleepSession);
  await ctx.db.delete(dailyMetrics);
});

/** Generate a date string N days before today in YYYY-MM-DD format. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Generate a timestamp at 22:00 UTC on the given date string. */
function sleepStart(dateStr: string): Date {
  return new Date(`${dateStr}T22:00:00Z`);
}

/** Generate a timestamp at 06:00 UTC on the day AFTER the given date string. */
function sleepEnd(dateStr: string): Date {
  const d = new Date(`${dateStr}T06:00:00Z`);
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Insert daily_metrics rows with HRV for a range of days.
 * Each date gets exactly one row to avoid unique constraint violations.
 */
async function insertDailyHrv(dates: Map<string, number>): Promise<void> {
  const rows = Array.from(dates.entries()).map(([date, hrv]) => ({
    date,
    providerId: "test-provider",
    userId: DEFAULT_USER_ID,
    hrv,
  }));
  if (rows.length > 0) {
    await ctx.db.insert(dailyMetrics).values(rows);
  }
}

describe("fitSleepFromDb", () => {
  it("executes the LATERAL subquery SQL without error on an empty database", async () => {
    await refreshDedupViews(ctx.db);
    const result = await fitSleepFromDb(ctx.db, DEFAULT_USER_ID);
    expect(result).toBeNull();
  });

  it("returns null when fewer than 14 qualifying nights exist", async () => {
    // Insert 5 sleep sessions (below the 14-night threshold)
    const sleepRows = [];
    for (let i = 30; i < 35; i++) {
      sleepRows.push({
        providerId: "test-provider",
        userId: DEFAULT_USER_ID,
        startedAt: sleepStart(daysAgo(i)),
        endedAt: sleepEnd(daysAgo(i)),
        durationMinutes: 480,
        sleepType: "sleep",
        externalId: `insufficient-${i}`,
      });
    }
    await ctx.db.insert(sleepSession).values(sleepRows);

    // Need HRV data covering the join dates and the 60-day rolling window.
    // Sleep on daysAgo(i) → ends on daysAgo(i-1) → nightly.date = daysAgo(i-1)
    // Join: h.date = n.date + 1 = daysAgo(i-2) → need HRV on daysAgo(i-2)
    const hrvDates = new Map<string, number>();
    for (let i = 1; i <= 95; i++) {
      hrvDates.set(daysAgo(i), 50.0);
    }
    await insertDailyHrv(hrvDates);

    await refreshDedupViews(ctx.db);

    const result = await fitSleepFromDb(ctx.db, DEFAULT_USER_ID);
    expect(result).toBeNull();
  });

  it("returns a valid sleep target when sufficient data exists", async () => {
    // Insert 90 days of daily_metrics with constant HRV (all at median)
    const hrvDates = new Map<string, number>();
    for (let i = 1; i <= 90; i++) {
      hrvDates.set(daysAgo(i), 50.0);
    }
    await insertDailyHrv(hrvDates);

    // Insert 20 sleep sessions within the past 90 days
    // Sleep on daysAgo(i) ends on daysAgo(i-1), so nightly.date = daysAgo(i-1)
    // Join: h.date = nightly.date + 1 = daysAgo(i-2) → need HRV on daysAgo(i-2)
    const sleepDuration = 480;
    const sleepRows = [];
    for (let i = 5; i < 25; i++) {
      sleepRows.push({
        providerId: "test-provider",
        userId: DEFAULT_USER_ID,
        startedAt: sleepStart(daysAgo(i)),
        endedAt: sleepEnd(daysAgo(i)),
        durationMinutes: sleepDuration,
        sleepType: "sleep",
        externalId: `sufficient-${i}`,
      });
    }
    await ctx.db.insert(sleepSession).values(sleepRows);

    await refreshDedupViews(ctx.db);

    const result = await fitSleepFromDb(ctx.db, DEFAULT_USER_ID);
    expect(result).not.toBeNull();
    expect(result!.minutes).toBe(sleepDuration);
    expect(result!.sampleCount).toBeGreaterThanOrEqual(14);
  });

  it("distinguishes above-median and below-median HRV nights", async () => {
    // Baseline: 90 days of low HRV (40). The rolling median will be ~40.
    const hrvDates = new Map<string, number>();
    for (let i = 1; i <= 90; i++) {
      hrvDates.set(daysAgo(i), 40.0);
    }

    // For the first 10 sleep sessions (i=5..14), set the HRV on their
    // join date (daysAgo(i-2)) to 80 — above the ~40 median.
    // For the remaining 10 (i=15..24), HRV stays at 40 = median, which
    // also qualifies (hrv >= median_hrv).
    for (let i = 5; i < 15; i++) {
      hrvDates.set(daysAgo(i - 2), 80.0);
    }
    await insertDailyHrv(hrvDates);

    // Insert 20 sleep sessions: 9h for above-median nights, 7h for at-median
    const sleepRows = [];
    for (let i = 5; i < 25; i++) {
      sleepRows.push({
        providerId: "test-provider",
        userId: DEFAULT_USER_ID,
        startedAt: sleepStart(daysAgo(i)),
        endedAt: sleepEnd(daysAgo(i)),
        durationMinutes: i < 15 ? 540 : 420,
        sleepType: "sleep",
        externalId: `median-${i}`,
      });
    }
    await ctx.db.insert(sleepSession).values(sleepRows);

    await refreshDedupViews(ctx.db);

    const result = await fitSleepFromDb(ctx.db, DEFAULT_USER_ID);
    // All 20 nights should qualify (10 above median, 10 at median)
    expect(result).not.toBeNull();
    expect(result!.sampleCount).toBeGreaterThanOrEqual(14);
  });
});
