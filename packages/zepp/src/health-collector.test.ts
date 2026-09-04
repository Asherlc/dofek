import { describe, expect, it, vi } from "vitest";
import type { NapInfo, SensorConstructors, SleepStage, SpO2Reading } from "./health-collector.ts";
import { collectHealthData } from "./health-collector.ts";

function makeSensors(overrides?: Partial<SensorConstructors>): SensorConstructors {
  return {
    HeartRate: class {
      getToday() {
        return Array.from({ length: 120 }, (_, _i) => 60 + Math.floor(Math.random() * 40));
      }
      getResting() {
        return 62;
      }
      getDailySummary() {
        return { maximum: { hr_value: 145, time: 36000 } };
      }
      getLast() {
        return 72;
      }
    },
    Step: class {
      getCurrent() {
        return 8432;
      }
      getTarget() {
        return 10000;
      }
    },
    Distance: class {
      getCurrent() {
        return 6500;
      }
    },
    Sleep: class {
      updateInfo() {}
      getInfo() {
        return { score: 85, deepTime: 90, startTime: 0, endTime: 420, totalTime: 400 };
      }
      getStage() {
        return [
          { model: 3, start: 0, stop: 30 },
          { model: 1, start: 30, stop: 60 },
          { model: 2, start: 60, stop: 90 },
        ];
      }
      getNap() {
        return [{ length: 30, start: 480, stop: 510 }];
      }
    },
    BloodOxygen: class {
      getCurrent() {
        return { value: 98 };
      }
      getLastDay() {
        return Array.from({ length: 24 }, () => 97);
      }
      getLastFewHour(_hours: number) {
        return Array.from({ length: 12 }, (_, i) => ({ spo2: 97, time: 1700000000 + i * 300 }));
      }
    },
    BodyTemperature: class {
      getCurrent() {
        return { current: 36.5 };
      }
      getToday() {
        return Array.from({ length: 288 }, () => 36.5);
      }
    },
    Stress: class {
      getToday() {
        return Array.from({ length: 60 }, () => 30);
      }
      getTodayByHour() {
        return Array.from({ length: 24 }, () => 30);
      }
      getLastWeek() {
        return [35, 32, 28, 33, 30, 29, 31];
      }
    },
    Stand: class {
      getCurrent() {
        return 10;
      }
    },
    Pai: class {
      getCurrent() {
        return 85;
      }
    },
    FatBurning: class {
      getCurrent() {
        return 30;
      }
    },
    Workout: class {
      getHistory() {
        return [
          { startTime: 1_720_000_000, duration: 3_600 },
          { startTime: 1_720_086_400, duration: 1_800 },
        ];
      }
    },
    ...overrides,
  };
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function collect(sensors: SensorConstructors) {
  return collectHealthData(sensors, vi.fn());
}

describe("collectHealthData", () => {
  it("collects all available sensor data", () => {
    const result = collect(makeSensors());

    expect(result.collectedAt).toBeGreaterThan(0);
    expect(result.date).toBe(formatLocalDate(new Date(result.collectedAt)));
    expect(result.timezoneOffsetMinutes).toBe(new Date(result.collectedAt).getTimezoneOffset());
    expect(result.steps).toBe(8432);
    expect(result.distance).toBe(6500);
    expect(result.restingHeartRate).toBe(62);
    expect(result.heartRateSummary?.maxHr).toBe(145);
    expect(result.sleep?.score).toBe(85);
    expect(result.sleep?.deepMinutes).toBe(90);
    expect(result.sleep?.stages).toHaveLength(3);
    expect(result.nap).toHaveLength(1);
    expect(result.bloodOxygenCurrent).toBe(98);
    expect(result.bloodOxygenHourly).toHaveLength(24);
    expect(result.spo2Recent).toHaveLength(12);
    expect(result.bodyTemperatureCurrent).toBe(36.5);
    expect(result.bodyTemperature).toHaveLength(288);
    expect(result.stress).toHaveLength(60);
    expect(result.stressWeekly).toEqual([35, 32, 28, 33, 30, 29, 31]);
    expect(result.standHours).toBe(10);
    expect(result.pai).toBe(85);
    expect(result.fatBurning).toBe(30);
    expect(result.activities).toEqual([
      {
        externalId: "1720000000",
        activityType: "other",
        startedAt: "2024-07-03T09:46:40.000Z",
        endedAt: "2024-07-03T10:46:40.000Z",
      },
      {
        externalId: "1720086400",
        activityType: "other",
        startedAt: "2024-07-04T09:46:40.000Z",
        endedAt: "2024-07-04T10:16:40.000Z",
      },
    ]);
  });

  it("handles missing sleep data gracefully", () => {
    const sensors = makeSensors({
      Sleep: class {
        updateInfo() {}
        getInfo() {
          return { score: 0, deepTime: 0, startTime: 0, endTime: 0, totalTime: 0 };
        }
        getStage() {
          return [];
        }
        getNap() {
          return [];
        }
      },
    });
    const result = collect(sensors);
    expect(result.sleep).toBeUndefined();
  });

  it("handles heart rate without daily summary maximum", () => {
    const sensors = makeSensors({
      HeartRate: class {
        getToday() {
          return [];
        }
        getResting() {
          return 0;
        }
        getDailySummary() {
          return {};
        }
        getLast() {
          return 0;
        }
      },
    });
    const result = collect(sensors);
    expect(result.heartRate).toEqual([]);
    expect(result.heartRateSummary).toBeUndefined();
  });

  it("handles blood oxygen with zero current value", () => {
    const sensors = makeSensors({
      BloodOxygen: class {
        getCurrent() {
          return { value: 0 };
        }
        getLastDay() {
          return [];
        }
        getLastFewHour(_hours: number) {
          return [];
        }
      },
    });
    const result = collect(sensors);
    expect(result.bloodOxygenCurrent).toBeUndefined();
    expect(result.bloodOxygenHourly).toEqual([]);
    expect(result.spo2Recent).toBeUndefined();
  });

  it("handles empty spo2 recent readings", () => {
    const sensors = makeSensors({
      BloodOxygen: class {
        getCurrent() {
          return { value: 99 };
        }
        getLastDay() {
          return [98, 97];
        }
        getLastFewHour(_hours: number) {
          return [];
        }
      },
    });
    const result = collect(sensors);
    expect(result.bloodOxygenCurrent).toBe(99);
    expect(result.spo2Recent).toBeUndefined();
  });

  it("handles body temperature with zero current", () => {
    const sensors = makeSensors({
      BodyTemperature: class {
        getCurrent() {
          return { current: 0 };
        }
        getToday() {
          return [];
        }
      },
    });
    const result = collect(sensors);
    expect(result.bodyTemperatureCurrent).toBeUndefined();
    expect(result.bodyTemperature).toEqual([]);
  });

  it("handles empty nap data", () => {
    const sensors = makeSensors({
      Sleep: class {
        updateInfo() {}
        getInfo() {
          return { score: 75, deepTime: 60, startTime: 0, endTime: 360, totalTime: 360 };
        }
        getStage() {
          return [];
        }
        getNap() {
          return [];
        }
      },
    });
    const result = collect(sensors);
    expect(result.sleep?.score).toBe(75);
    expect(result.nap).toBeUndefined();
  });

  it("handles unavailable sensors gracefully", () => {
    // A class that throws on construction but satisfies all sensor interfaces
    class ThrowingSensor {
      constructor() {
        throw new Error("sensor not available");
      }
      getToday(): number[] {
        return [];
      }
      getResting(): number {
        return 0;
      }
      getDailySummary(): { maximum?: { hr_value: number; time: number } } {
        return {};
      }
      getLast(): number {
        return 0;
      }
      getCurrent(): never {
        throw new Error("sensor not available");
      }
      getTarget(): number {
        return 0;
      }
      updateInfo(): void {}
      getInfo(): {
        score: number;
        deepTime: number;
        startTime: number;
        endTime: number;
        totalTime: number;
      } {
        return { score: 0, deepTime: 0, startTime: 0, endTime: 0, totalTime: 0 };
      }
      getStage(): SleepStage[] {
        return [];
      }
      getNap(): NapInfo[] {
        return [];
      }
      getLastDay(): number[] {
        return [];
      }
      getLastFewHour(_hours: number): SpO2Reading[] {
        return [];
      }
      getTodayByHour(): number[] {
        return [];
      }
      getLastWeek(): number[] {
        return [];
      }
      getHistory(): [] {
        return [];
      }
    }
    const captureException = vi.fn();
    const result = collectHealthData(
      makeSensors({
        HeartRate: ThrowingSensor,
        Step: ThrowingSensor,
        Distance: ThrowingSensor,
        Sleep: ThrowingSensor,
        BloodOxygen: ThrowingSensor,
        BodyTemperature: ThrowingSensor,
        Stress: ThrowingSensor,
        Stand: ThrowingSensor,
        Pai: ThrowingSensor,
        FatBurning: ThrowingSensor,
        Workout: ThrowingSensor,
      } satisfies Partial<SensorConstructors>),
      captureException,
    );

    expect(result.heartRate).toBeUndefined();
    expect(result.steps).toBeUndefined();
    expect(result.sleep).toBeUndefined();
    expect(result.activities).toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(11);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      operation: "collect",
      sensor: "HeartRate",
    });
  });

  it("normalizes invalid and sentinel values without discarding valid siblings", () => {
    const result = collect(
      makeSensors({
        HeartRate: class {
          getToday() {
            return [61, Number.NaN, Number.POSITIVE_INFINITY, -1, 65];
          }
          getResting() {
            return Number.NaN;
          }
          getDailySummary() {
            return { maximum: { hr_value: Number.POSITIVE_INFINITY, time: -1 } };
          }
          getLast() {
            return 65;
          }
        },
        Step: class {
          getCurrent() {
            return -1;
          }
          getTarget() {
            return Number.NaN;
          }
        },
        Distance: class {
          getCurrent() {
            return Number.POSITIVE_INFINITY;
          }
        },
        BloodOxygen: class {
          getCurrent() {
            return { value: 101 };
          }
          getLastDay() {
            return [98, Number.NaN, 0, 101];
          }
          getLastFewHour(_hours: number) {
            return [
              { spo2: 97, time: 1_700_000_000 },
              { spo2: Number.NaN, time: 1_700_000_300 },
              { spo2: 98, time: Number.POSITIVE_INFINITY },
            ];
          }
        },
        BodyTemperature: class {
          getCurrent() {
            return { current: Number.NaN };
          }
          getToday() {
            return [36.5, Number.NaN, Number.POSITIVE_INFINITY, -1000];
          }
        },
        Stress: class {
          getToday() {
            return [30, Number.NaN, -1, 35];
          }
          getTodayByHour() {
            return [25, Number.POSITIVE_INFINITY];
          }
          getLastWeek() {
            return [20, -1, Number.NaN];
          }
        },
        Stand: class {
          getCurrent() {
            return -1;
          }
        },
        Pai: class {
          getCurrent() {
            return Number.NaN;
          }
        },
        FatBurning: class {
          getCurrent() {
            return 2.5;
          }
        },
        Workout: class {
          getHistory() {
            return [
              { startTime: Number.NaN, duration: 600 },
              { startTime: 1_720_000_000, duration: -1 },
              { startTime: 1_720_086_400, duration: 1_800 },
            ];
          }
        },
      }),
    );

    expect(result).toMatchObject({
      heartRate: [61, 0, 0, 0, 65],
      bloodOxygenHourly: [98, 0, 0, 0],
      spo2Recent: [{ spo2: 97, time: 1_700_000_000 }],
      bodyTemperature: [36.5, -1000, -1000, -1000],
      stress: [30, 0, 0, 35],
      stressByHour: [25, 0],
      stressWeekly: [20, 0, 0],
      activities: [
        {
          externalId: "1720086400",
          activityType: "other",
          startedAt: "2024-07-04T09:46:40.000Z",
          endedAt: "2024-07-04T10:16:40.000Z",
        },
      ],
    });
    expect(result.restingHeartRate).toBeUndefined();
    expect(result.heartRateSummary).toBeUndefined();
    expect(result.steps).toBeUndefined();
    expect(result.stepsTarget).toBeUndefined();
    expect(result.distance).toBeUndefined();
    expect(result.bloodOxygenCurrent).toBeUndefined();
    expect(result.bodyTemperatureCurrent).toBeUndefined();
    expect(result.standHours).toBeUndefined();
    expect(result.pai).toBeUndefined();
    expect(result.fatBurning).toBeUndefined();
  });
});
