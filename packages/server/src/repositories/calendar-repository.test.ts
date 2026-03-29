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
    expect(new CalendarDay(row).toDetail()).toEqual(row);
  });
});

describe("CalendarRepository", () => {
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
      { date: "2024-06-15", activity_count: 2, total_minutes: 90, activity_types: ["cycling"] },
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
});
