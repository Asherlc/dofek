import { describe, expect, it, vi } from "vitest";
import {
  appendBackgroundHealthEvents,
  collectBackgroundHealthSample,
} from "./background-health.ts";
import { createEmptyOutbox } from "./durable-outbox.ts";

describe("collectBackgroundHealthSample", () => {
  it("collects low-power readings and completed workouts", () => {
    const captureException = vi.fn();
    const result = collectBackgroundHealthSample(
      {
        captureException,
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
    expect(captureException).not.toHaveBeenCalled();
  });

  it("omits unavailable and non-positive sensor values without stopping collection", () => {
    const captureException = vi.fn();
    const ThrowingSensor = class {
      getLast(): number {
        throw new Error("unavailable");
      }
      getCurrent(): { value: number; current: number } {
        throw new Error("unavailable");
      }
      getToday(): number[] {
        throw new Error("unavailable");
      }
      getHistory(): [] {
        throw new Error("unavailable");
      }
    };
    expect(
      collectBackgroundHealthSample(
        {
          captureException,
          HeartRate: ThrowingSensor,
          BloodOxygen: ThrowingSensor,
          BodyTemperature: ThrowingSensor,
          Stress: ThrowingSensor,
          Workout: ThrowingSensor,
        },
        1_720_003_700_000,
      ),
    ).toEqual({
      sample: { recordedAt: "2024-07-03T10:48:20.000Z" },
      activities: [],
    });
    expect(captureException).toHaveBeenCalledTimes(5);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("uses the latest positive stress reading and omits zero-valued readings", () => {
    const captureException = vi.fn();
    const result = collectBackgroundHealthSample(
      {
        captureException,
        HeartRate: class {
          getLast() {
            return 0;
          }
        },
        BloodOxygen: class {
          getCurrent() {
            return { value: 0 };
          }
        },
        BodyTemperature: class {
          getCurrent() {
            return { current: 0 };
          }
        },
        Stress: class {
          getToday() {
            return [12, 0, 0];
          }
        },
        Workout: class {
          getHistory() {
            return [];
          }
        },
      },
      1_720_003_700_000,
    );

    expect(result).toEqual({
      sample: { recordedAt: "2024-07-03T10:48:20.000Z", stress: 12 },
      activities: [],
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("omits non-finite background values before persistence", () => {
    const captureException = vi.fn();
    const result = collectBackgroundHealthSample(
      {
        captureException,
        HeartRate: class {
          getLast() {
            return Number.POSITIVE_INFINITY;
          }
        },
        BloodOxygen: class {
          getCurrent() {
            return { value: 101 };
          }
        },
        BodyTemperature: class {
          getCurrent() {
            return { current: Number.NaN };
          }
        },
        Stress: class {
          getToday() {
            return [30, Number.POSITIVE_INFINITY];
          }
        },
        Workout: class {
          getHistory() {
            return [];
          }
        },
      },
      1_720_003_700_000,
    );

    expect(result).toEqual({
      sample: { recordedAt: "2024-07-03T10:48:20.000Z", stress: 30 },
      activities: [],
    });
  });
});

describe("appendBackgroundHealthEvents", () => {
  it("deduplicates stable events and retains the newest seven days of minute samples", () => {
    let outbox = createEmptyOutbox<
      | { kind: "sample"; sample: { recordedAt: string; heartRate?: number } }
      | {
          kind: "activity";
          activity: {
            externalId: string;
            activityType: "other";
            startedAt: string;
            endedAt: string;
          };
        }
    >();
    const activity = {
      externalId: "1720000000",
      activityType: "other" as const,
      startedAt: "2024-07-03T09:46:40.000Z",
      endedAt: "2024-07-03T10:46:40.000Z",
    };

    for (let minute = 0; minute <= 10_080; minute++) {
      outbox = appendBackgroundHealthEvents(
        outbox,
        {
          sample: { recordedAt: new Date(minute * 60_000).toISOString(), heartRate: 60 },
          activities: [activity],
        },
        "install-1",
      );
    }

    const samples = outbox.pending.filter((entry) => entry.payload.kind === "sample");
    const activities = outbox.pending.filter((entry) => entry.payload.kind === "activity");
    expect(samples).toHaveLength(10_080);
    expect(samples[0]).toMatchObject({
      eventId: `install-1:background-sample:${new Date(60_000).toISOString()}`,
      payload: { kind: "sample", sample: { recordedAt: new Date(60_000).toISOString() } },
    });
    expect(activities).toEqual([
      expect.objectContaining({
        eventId: `install-1:activity:${activity.externalId}:${activity.endedAt}`,
        payload: { kind: "activity", activity },
      }),
    ]);
  });

  it("retains activity revisions as separate raw events", () => {
    const oldActivity = {
      externalId: "1720000000",
      activityType: "other" as const,
      startedAt: "2024-07-03T09:46:40.000Z",
      endedAt: "2024-07-03T10:46:40.000Z",
    };
    const updatedActivity = { ...oldActivity, endedAt: "2024-07-03T10:50:00.000Z" };

    expect(
      appendBackgroundHealthEvents(
        appendBackgroundHealthEvents(
          createEmptyOutbox(),
          {
            sample: { recordedAt: "2024-07-03T10:49:00.000Z" },
            activities: [oldActivity],
          },
          "install-1",
        ),
        {
          sample: { recordedAt: "2024-07-03T10:50:00.000Z" },
          activities: [updatedActivity],
        },
        "install-1",
      ).pending.filter((entry) => entry.payload.kind === "activity"),
    ).toEqual([
      expect.objectContaining({ payload: { kind: "activity", activity: oldActivity } }),
      expect.objectContaining({ payload: { kind: "activity", activity: updatedActivity } }),
    ]);
  });
});
