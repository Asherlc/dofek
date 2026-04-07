import {
  parseEightSleepDailyMetrics,
  parseEightSleepHeartRateSamples,
  parseEightSleepTrendDay,
} from "eight-sleep-client/parsing";
import { describe, expect, it } from "vitest";

// ============================================================
// Sample API responses
// ============================================================

const sampleTrendDay = {
  day: "2026-03-01",
  score: 85,
  tnt: 12,
  processing: false,
  presenceDuration: 28800, // 8 hours in seconds
  sleepDuration: 25200, // 7 hours
  lightDuration: 10800, // 3 hours
  deepDuration: 7200, // 2 hours
  remDuration: 5400, // 1.5 hours
  latencyAsleepSeconds: 600,
  latencyOutSeconds: 300,
  presenceStart: "2026-02-28T23:00:00.000Z",
  presenceEnd: "2026-03-01T07:00:00.000Z",
  sleepQualityScore: {
    total: 82,
    hrv: { score: 75, current: 45.2, average: 42.0 },
    respiratoryRate: { score: 90, current: 15.3, average: 15.0 },
    heartRate: { score: 85, current: 52, average: 55 },
    tempBedC: { average: 28.5 },
    tempRoomC: { average: 20.1 },
    sleepDurationSeconds: { score: 88 },
  },
  sleepRoutineScore: {
    total: 78,
    latencyAsleepSeconds: { score: 70 },
    latencyOutSeconds: { score: 80 },
    wakeupConsistency: { score: 85 },
  },
  sleepFitnessScore: { total: 80 },
  sessions: [
    {
      stages: [
        { stage: "light", duration: 1200 },
        { stage: "deep", duration: 3600 },
        { stage: "rem", duration: 2700 },
        { stage: "awake", duration: 300 },
      ],
      timeseries: {
        heartRate: [
          ["2026-02-28T23:05:00.000Z", 58],
          ["2026-02-28T23:10:00.000Z", 55],
          ["2026-02-28T23:15:00.000Z", 52],
          ["2026-03-01T02:00:00.000Z", 48],
        ] satisfies Array<[string, number]>,
        tempBedC: [
          ["2026-02-28T23:05:00.000Z", 27.5],
          ["2026-03-01T02:00:00.000Z", 28.0],
        ] satisfies Array<[string, number]>,
      },
    },
  ],
};

// ============================================================
// Tests
// ============================================================

describe("Eight Sleep Provider", () => {
  describe("parseEightSleepTrendDay", () => {
    it("maps sleep session fields correctly", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);

      expect(result.externalId).toBe("eightsleep-2026-03-01");
      expect(result.startedAt).toEqual(new Date("2026-02-28T23:00:00.000Z"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T07:00:00.000Z"));
      expect(result.isNap).toBe(false);
    });

    it("converts durations from seconds to minutes", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);

      expect(result.durationMinutes).toBe(420); // 25200 / 60 = 420
      expect(result.deepMinutes).toBe(120); // 7200 / 60
      expect(result.remMinutes).toBe(90); // 5400 / 60
      expect(result.lightMinutes).toBe(180); // 10800 / 60
    });

    it("calculates awake minutes from presence minus sleep duration", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);
      // awake = presenceDuration - sleepDuration = 28800 - 25200 = 3600s = 60 min
      expect(result.awakeMinutes).toBe(60);
    });

    it("does not include efficiencyPct (derived in v_sleep view)", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);
      expect(result).not.toHaveProperty("efficiencyPct");
    });
  });

  describe("parseEightSleepDailyMetrics", () => {
    it("extracts daily health metrics from quality scores", () => {
      const result = parseEightSleepDailyMetrics(sampleTrendDay);

      expect(result.date).toBe("2026-03-01");
      expect(result.restingHr).toBe(52);
      expect(result.hrv).toBe(45.2);
      expect(result.respiratoryRateAvg).toBe(15.3);
      expect(result.skinTempC).toBe(28.5);
    });

    it("handles missing quality scores", () => {
      const noQuality = {
        ...sampleTrendDay,
        sleepQualityScore: undefined,
      };
      const result = parseEightSleepDailyMetrics(noQuality);

      expect(result.date).toBe("2026-03-01");
      expect(result.restingHr).toBeUndefined();
      expect(result.hrv).toBeUndefined();
      expect(result.respiratoryRateAvg).toBeUndefined();
      expect(result.skinTempC).toBeUndefined();
    });

    it("handles partial quality scores", () => {
      const partialQuality = {
        ...sampleTrendDay,
        sleepQualityScore: {
          total: 50,
          hrv: { score: 75, current: 40, average: 38 },
        },
      };
      const result = parseEightSleepDailyMetrics(partialQuality);

      expect(result.hrv).toBe(40);
      expect(result.restingHr).toBeUndefined();
      expect(result.respiratoryRateAvg).toBeUndefined();
    });
  });

  describe("parseEightSleepHeartRateSamples", () => {
    it("extracts HR samples from session timeseries", () => {
      const result = parseEightSleepHeartRateSamples(sampleTrendDay.sessions ?? []);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        recordedAt: new Date("2026-02-28T23:05:00.000Z"),
        heartRate: 58,
      });
      expect(result[3]).toEqual({
        recordedAt: new Date("2026-03-01T02:00:00.000Z"),
        heartRate: 48,
      });
    });

    it("filters out zero bpm values", () => {
      const sessionsWithZero = [
        {
          stages: [],
          timeseries: {
            heartRate: [
              ["2026-03-01T00:00:00Z", 55],
              ["2026-03-01T00:05:00Z", 0],
              ["2026-03-01T00:10:00Z", 52],
            ] satisfies Array<[string, number]>,
          },
        },
      ];
      const result = parseEightSleepHeartRateSamples(sessionsWithZero);

      expect(result).toHaveLength(2);
      expect(result[0]?.heartRate).toBe(55);
      expect(result[1]?.heartRate).toBe(52);
    });

    it("handles sessions without HR timeseries", () => {
      const noHr = [{ stages: [], timeseries: {} }];
      const result = parseEightSleepHeartRateSamples(noHr);
      expect(result).toHaveLength(0);
    });

    it("handles empty sessions array", () => {
      const result = parseEightSleepHeartRateSamples([]);
      expect(result).toHaveLength(0);
    });

    it("combines HR samples from multiple sessions", () => {
      const multiSession = [
        {
          stages: [],
          timeseries: {
            heartRate: [["2026-03-01T00:00:00Z", 55]] satisfies Array<[string, number]>,
          },
        },
        {
          stages: [],
          timeseries: {
            heartRate: [["2026-03-01T01:00:00Z", 50]] satisfies Array<[string, number]>,
          },
        },
      ];
      const result = parseEightSleepHeartRateSamples(multiSession);
      expect(result).toHaveLength(2);
    });
  });
});
