import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { CalendarDay, CalendarRepository } from "./calendar-repository.ts";

describe("CalendarDay", () => {
  it("exposes date and activityCount", () => {
    const day = new CalendarDay({
      date: "2024-06-15",
      activityCount: 2,
      totalMinutes: 90,
      activityTypes: ["cycling", "running"],
    });
    expect(day.date).toBe("2024-06-15");
    expect(day.activityCount).toBe(2);
  });

  it("serializes to API shape via toDetail()", () => {
    const row = {
      date: "2024-06-15",
      activityCount: 2,
      totalMinutes: 90,
      activityTypes: ["cycling", "running"],
    };
    expect(new CalendarDay(row).toDetail()).toEqual({
      ...row,
      trainingTimeBand: "high",
      trainingTimeMeaning:
        "High training volume; compare with recovery before stacking another hard day.",
    });
  });
});

describe("CalendarRepository", () => {
  const dialect = new PgDialect();

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new CalendarRepository({ execute }, "user-1", "UTC");
    return { repo, execute };
  }

  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    expect(await repo.getCalendarData(365)).toEqual([]);
  });

  it("returns CalendarDay instances", async () => {
    const { repo } = makeRepository([
      { date: "2024-06-15", activity_count: 2, total_minutes: 90, canonical_types: ["cycling"] },
    ]);
    const result = await repo.getCalendarData(365);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(CalendarDay);
    expect(result[0]?.toDetail().activityCount).toBe(2);
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getCalendarData(30);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("applies finite selected-range lower-bound filters", async () => {
    const { repo, execute } = makeRepository([]);

    await repo.getCalendarData(30);

    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql).toContain("a.started_at > CURRENT_TIMESTAMP -");
    expect(compiledQuery.sql).toContain("::int * INTERVAL '1 day'");
    expect(compiledQuery.params).toEqual(expect.arrayContaining(["user-1", 30]));
  });

  it("omits selected-range lower-bound filters when days is null", async () => {
    const { repo, execute } = makeRepository([]);

    await repo.getCalendarData(null);

    const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(compiledQuery.sql).toContain("FROM fitness.v_activity a");
    expect(compiledQuery.sql).not.toContain("CURRENT_TIMESTAMP -");
    expect(compiledQuery.params).not.toContain(null);
  });
});
