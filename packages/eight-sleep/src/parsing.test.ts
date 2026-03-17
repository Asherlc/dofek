import { describe, expect, it } from "vitest";
import {
  parseEightSleepDailyMetrics,
  parseEightSleepHeartRateSamples,
  parseEightSleepTrendDay,
} from "./parsing.ts";
import type { EightSleepSession, EightSleepTrendDay } from "./types.ts";

const sampleTrendDay: EightSleepTrendDay = {
  day: "2026-03-15",
  score: 85,
  tnt: 3,
  processing: false,
  presenceDuration: 28800, // 8 hours
  sleepDuration: 25200, // 7 hours
  lightDuration: 10800, // 3 hours
  deepDuration: 7200, // 2 hours
  remDuration: 5400, // 1.5 hours
  latencyAsleepSeconds: 600,
  latencyOutSeconds: 300,
  presenceStart: "2026-03-14T22:30:00Z",
  presenceEnd: "2026-03-15T06:30:00Z",
  sleepQualityScore: {
    total: 88,
    heartRate: { score: 90, current: 58, average: 60 },
    hrv: { score: 85, current: 42, average: 40 },
    respiratoryRate: { score: 80, current: 15.2, average: 15.0 },
    tempBedC: { average: 33.5 },
  },
};

describe("parseEightSleepTrendDay", () => {
  it("parses a complete trend day into session data", () => {
    const result = parseEightSleepTrendDay(sampleTrendDay);

    expect(result.externalId).toBe("eightsleep-2026-03-15");
    expect(result.startedAt).toEqual(new Date("2026-03-14T22:30:00Z"));
    expect(result.endedAt).toEqual(new Date("2026-03-15T06:30:00Z"));
    expect(result.durationMinutes).toBe(420); // 25200s / 60
    expect(result.deepMinutes).toBe(120); // 7200s / 60
    expect(result.remMinutes).toBe(90); // 5400s / 60
    expect(result.lightMinutes).toBe(180); // 10800s / 60
    expect(result.awakeMinutes).toBe(60); // (28800 - 25200) / 60
    expect(result.efficiencyPct).toBe(88); // round(25200/28800 * 100)
    expect(result.isNap).toBe(false);
  });

  it("handles zero presence duration without dividing by zero", () => {
    const day: EightSleepTrendDay = {
      ...sampleTrendDay,
      presenceDuration: 0,
      sleepDuration: 0,
    };
    const result = parseEightSleepTrendDay(day);
    expect(result.efficiencyPct).toBe(0);
  });

  it("rounds seconds to minutes correctly", () => {
    const day: EightSleepTrendDay = {
      ...sampleTrendDay,
      sleepDuration: 89, // 1.48 min -> rounds to 1
      deepDuration: 150, // 2.5 min -> rounds to 3 (Math.round)
      remDuration: 31, // 0.52 min -> rounds to 1
      lightDuration: 29, // 0.48 min -> rounds to 0
    };
    const result = parseEightSleepTrendDay(day);
    expect(result.durationMinutes).toBe(1);
    expect(result.deepMinutes).toBe(3);
    expect(result.remMinutes).toBe(1);
    expect(result.lightMinutes).toBe(0);
  });
});

describe("parseEightSleepDailyMetrics", () => {
  it("extracts daily metrics from a trend day with quality scores", () => {
    const result = parseEightSleepDailyMetrics(sampleTrendDay);

    expect(result.date).toBe("2026-03-15");
    expect(result.restingHr).toBe(58);
    expect(result.hrv).toBe(42);
    expect(result.respiratoryRateAvg).toBe(15.2);
    expect(result.skinTempC).toBe(33.5);
  });

  it("returns undefined for missing quality score fields", () => {
    const day: EightSleepTrendDay = {
      ...sampleTrendDay,
      sleepQualityScore: undefined,
    };
    const result = parseEightSleepDailyMetrics(day);

    expect(result.date).toBe("2026-03-15");
    expect(result.restingHr).toBeUndefined();
    expect(result.hrv).toBeUndefined();
    expect(result.respiratoryRateAvg).toBeUndefined();
    expect(result.skinTempC).toBeUndefined();
  });

  it("handles partial quality scores", () => {
    const day: EightSleepTrendDay = {
      ...sampleTrendDay,
      sleepQualityScore: {
        total: 70,
        heartRate: { score: 80, current: 62, average: 60 },
        // no hrv, respiratoryRate, tempBedC
      },
    };
    const result = parseEightSleepDailyMetrics(day);

    expect(result.restingHr).toBe(62);
    expect(result.hrv).toBeUndefined();
    expect(result.respiratoryRateAvg).toBeUndefined();
    expect(result.skinTempC).toBeUndefined();
  });
});

describe("parseEightSleepHeartRateSamples", () => {
  it("extracts heart rate samples from sessions", () => {
    const sessions: EightSleepSession[] = [
      {
        stages: [],
        timeseries: {
          heartRate: [
            ["2026-03-15T01:00:00Z", 55.3],
            ["2026-03-15T02:00:00Z", 58.7],
          ],
        },
      },
    ];
    const result = parseEightSleepHeartRateSamples(sessions);

    expect(result).toHaveLength(2);
    expect(result[0].recordedAt).toEqual(new Date("2026-03-15T01:00:00Z"));
    expect(result[0].heartRate).toBe(55);
    expect(result[1].heartRate).toBe(59);
  });

  it("skips samples with zero bpm", () => {
    const sessions: EightSleepSession[] = [
      {
        stages: [],
        timeseries: {
          heartRate: [
            ["2026-03-15T01:00:00Z", 0],
            ["2026-03-15T02:00:00Z", 60],
          ],
        },
      },
    ];
    const result = parseEightSleepHeartRateSamples(sessions);

    expect(result).toHaveLength(1);
    expect(result[0].heartRate).toBe(60);
  });

  it("skips sessions without heart rate timeseries", () => {
    const sessions: EightSleepSession[] = [
      {
        stages: [],
        timeseries: {},
      },
    ];
    const result = parseEightSleepHeartRateSamples(sessions);
    expect(result).toHaveLength(0);
  });

  it("handles multiple sessions", () => {
    const sessions: EightSleepSession[] = [
      {
        stages: [],
        timeseries: {
          heartRate: [["2026-03-15T01:00:00Z", 55]],
        },
      },
      {
        stages: [],
        timeseries: {
          heartRate: [["2026-03-15T03:00:00Z", 62]],
        },
      },
    ];
    const result = parseEightSleepHeartRateSamples(sessions);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty sessions list", () => {
    const result = parseEightSleepHeartRateSamples([]);
    expect(result).toHaveLength(0);
  });
});
