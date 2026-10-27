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

  it("accepts numeric metrics and excludes unavailable or malformed values", async () => {
    const responses: Partial<Record<(typeof SPORT_DATA_TYPES)[number], unknown>> = {
      speed: 4.25,
      duration: "12:34:56",
      pace: "12'34\"",
      avg_pace: "invalid",
      distance: "not-a-number",
      cadence: { value: 170 },
    };
    const snapshot = await collectLiveWorkoutSnapshot(
      (options, callback) => {
        if (options.type === "avg_speed") return false;
        callback({
          code: options.type === "altitude" ? 1 : 0,
          data:
            options.type === "total_count"
              ? "not-json"
              : JSON.stringify([{ [options.type]: responses[options.type] }]),
        });
        return true;
      },
      () => 0,
      1_720_000_312_000,
    );

    expect(snapshot).toEqual({
      recordedAt: "2024-07-03T09:51:52.000Z",
      heartRate: undefined,
      metrics: { speed: 4.25, duration: 45_296, pace: 754 },
    });
  });

  it("parses short workout durations in minutes and seconds", async () => {
    const snapshot = await collectLiveWorkoutSnapshot(
      (options, callback) => {
        callback({
          code: 0,
          data: JSON.stringify([{ [options.type]: options.type === "duration" ? "05:12" : null }]),
        });
        return true;
      },
      () => 0,
      1_720_000_312_000,
    );

    expect(snapshot.metrics.duration).toBe(312);
  });

  it("rejects invalid sport-data response containers", async () => {
    for (const data of ["{}", "[]", "[null]"] as const) {
      const snapshot = await collectLiveWorkoutSnapshot(
        (_options, callback) => {
          callback({ code: 0, data });
          return true;
        },
        () => -1,
      );
      expect(snapshot.metrics).toEqual({});
    }
  });

  it("keeps small start-time variations in one workout and separates later workouts", () => {
    const snapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      metrics: { duration: 312 },
    };

    expect(findLiveWorkoutExternalId(snapshot, ["1719999998", "1720003600"])).toBe("1719999998");
    expect(findLiveWorkoutExternalId(snapshot, ["1719999995"])).toBe("1719999995");
    expect(findLiveWorkoutExternalId(snapshot, ["1720003600"])).toBe("1720000000");
    expect(findLiveWorkoutExternalId({ recordedAt: snapshot.recordedAt, metrics: {} }, [])).toBe(
      undefined,
    );
    expect(
      findLiveWorkoutExternalId({ recordedAt: snapshot.recordedAt, metrics: {} }, ["fallback"]),
    ).toBe("fallback");
  });
});
