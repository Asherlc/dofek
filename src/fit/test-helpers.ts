import type { ParsedFitActivity } from "./parser.ts";

export function parsedFitActivityFixture(): ParsedFitActivity {
  return {
    session: {
      sport: "cycling",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      totalElapsedTime: 1,
      totalTimerTime: 1,
      totalDistance: 1,
      totalCalories: 1,
      raw: {},
    },
    records: [],
    laps: [],
    events: [],
  };
}
