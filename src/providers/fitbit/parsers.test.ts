import { describe, expect, it } from "vitest";
import type { FitbitSleepLog } from "./client.ts";
import { parseFitbitSleep } from "./parsers.ts";

const completeSleep: FitbitSleepLog = {
  logId: 1,
  dateOfSleep: "2026-07-29",
  startTime: "2026-07-28T22:00:00.000Z",
  endTime: "2026-07-29T06:00:00.000Z",
  duration: 28_800_000,
  efficiency: 90,
  isMainSleep: true,
  type: "stages",
  levels: {
    summary: {
      deep: { count: 3, minutes: 90, thirtyDayAvgMinutes: 85 },
      light: { count: 12, minutes: 240, thirtyDayAvgMinutes: 230 },
      rem: { count: 4, minutes: 120, thirtyDayAvgMinutes: 110 },
      wake: { count: 5, minutes: 30, thirtyDayAvgMinutes: 35 },
    },
  },
};

describe("parseFitbitSleep", () => {
  it("marks a complete provider stage bundle as available", () => {
    expect(parseFitbitSleep(completeSleep).stagingAvailable).toBe(true);
  });

  it.each(["deep", "light", "rem", "wake"] as const)(
    "marks staging unavailable when %s is absent",
    (missingStage) => {
      const summary = { ...completeSleep.levels.summary, [missingStage]: undefined };
      const parsed = parseFitbitSleep({
        ...completeSleep,
        levels: { summary },
      });

      expect(parsed.stagingAvailable).toBe(false);
    },
  );
});
