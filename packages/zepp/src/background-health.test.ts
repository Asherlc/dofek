import { describe, expect, it } from "vitest";
import {
  appendBackgroundHealthSample,
  collectBackgroundHealthSample,
  emptyBackgroundHealthBuffer,
} from "./background-health.ts";

describe("collectBackgroundHealthSample", () => {
  it("collects low-power readings and completed workouts", () => {
    const result = collectBackgroundHealthSample(
      {
        HeartRate: class {
          getLast() {
            return 72;
          }
        },
        BloodOxygen: class {
          getCurrent() {
            return { value: 98 };
          }
        },
        BodyTemperature: class {
          getCurrent() {
            return { current: 36.6 };
          }
        },
        Stress: class {
          getToday() {
            return [0, 32, 35];
          }
        },
        Workout: class {
          getHistory() {
            return [{ startTime: 1_720_000_000, duration: 3_600 }];
          }
        },
      },
      1_720_003_700_000,
    );

    expect(result).toEqual({
      sample: {
        recordedAt: "2024-07-03T10:48:20.000Z",
        heartRate: 72,
        bloodOxygenPercent: 98,
        bodyTemperatureCelsius: 36.6,
        stress: 35,
      },
      activities: [
        {
          externalId: "1720000000",
          activityType: "other",
          startedAt: "2024-07-03T09:46:40.000Z",
          endedAt: "2024-07-03T10:46:40.000Z",
        },
      ],
    });
  });
});

describe("appendBackgroundHealthSample", () => {
  it("deduplicates activities and retains the newest seven days of minute samples", () => {
    let buffer = emptyBackgroundHealthBuffer();
    const activity = {
      externalId: "1720000000",
      activityType: "other" as const,
      startedAt: "2024-07-03T09:46:40.000Z",
      endedAt: "2024-07-03T10:46:40.000Z",
    };

    for (let minute = 0; minute <= 10_080; minute++) {
      buffer = appendBackgroundHealthSample(buffer, {
        sample: { recordedAt: new Date(minute * 60_000).toISOString(), heartRate: 60 },
        activities: [activity],
      });
    }

    expect(buffer.samples).toHaveLength(10_080);
    expect(buffer.samples[0]?.recordedAt).toBe(new Date(60_000).toISOString());
    expect(buffer.activities).toEqual([activity]);
  });
});
