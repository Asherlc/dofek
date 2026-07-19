import { describe, expect, it } from "vitest";
import {
  collectLiveWorkoutSnapshot,
  findLiveWorkoutExternalId,
  SPORT_DATA_TYPES,
} from "./workout-live.ts";

describe("collectLiveWorkoutSnapshot", () => {
  it("collects every official sport-data field and the current heart rate", async () => {
    const values: Record<string, string> = {
      speed: "3.5",
      avg_speed: "3.1",
      pace: "5'12\"",
      avg_pace: "5'30\"",
      distance: "1000",
      duration: "0:05:12",
      calories: "75",
      cadence: "172",
      avg_cadence: "168",
      altitude: "125.4",
      total_up_altitude: "42",
      total_count: "900",
      vertical_speed: "0.4",
      downhill_count: "2",
      total_downhill_distance: "120",
    };
    const requestedTypes: string[] = [];

    const snapshot = await collectLiveWorkoutSnapshot(
      (options, callback) => {
        requestedTypes.push(options.type);
        callback({
          code: 0,
          data: JSON.stringify([{ [options.type]: values[options.type] }]),
        });
        return true;
      },
      () => 148,
      1_720_000_312_000,
    );

    expect(requestedTypes).toEqual(SPORT_DATA_TYPES);
    expect(snapshot).toEqual({
      recordedAt: "2024-07-03T09:51:52.000Z",
      heartRate: 148,
      metrics: {
        speed: 3.5,
        avg_speed: 3.1,
        pace: 312,
        avg_pace: 330,
        distance: 1000,
        duration: 312,
        calories: 75,
        cadence: 172,
        avg_cadence: 168,
        altitude: 125.4,
        total_up_altitude: 42,
        total_count: 900,
        vertical_speed: 0.4,
        downhill_count: 2,
        total_downhill_distance: 120,
      },
    });
  });

  it("keeps small start-time variations in one workout and separates later workouts", () => {
    const snapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      metrics: { duration: 312 },
    };

    expect(findLiveWorkoutExternalId(snapshot, ["1719999998", "1720003600"])).toBe("1719999998");
    expect(findLiveWorkoutExternalId(snapshot, ["1720003600"])).toBe("1720000000");
  });
});
