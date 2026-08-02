import { describe, expect, it } from "vitest";
import { CalendarDay } from "./calendar-repository.ts";

describe("CalendarDay heatmap contract", () => {
  it("adds a server-authored volume band and recovery-safe meaning", () => {
    const detail = new CalendarDay({
      date: "2024-06-15",
      activityCount: 2,
      totalMinutes: 121,
      activityTypes: ["cycling", "running"],
    }).toDetail();

    expect(detail.trainingTimeBand).toBe("very_high");
    expect(detail.trainingTimeMeaning).toContain("recovery");
  });
});
