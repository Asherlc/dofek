import { describe, expect, it } from "vitest";
import {
  estimateThreshold,
  modelPower,
  type PowerObservation,
  projectThresholdHistory,
} from "./threshold.ts";

const curves = [
  { criticalPowerWatts: 180, workCapacityJoules: 20000, timeOffsetSeconds: 20 },
  { criticalPowerWatts: 280, workCapacityJoules: 30000, timeOffsetSeconds: 30 },
] as const;
const thresholdPolicy = {
  minimumDurationSeconds: 180,
  maximumDurationSeconds: 1800,
  targetDurationSeconds: 3600,
};
const historyPolicy = {
  comparisonWindowDays: 14,
  minimumHistoryDays: 28,
  maximumDailyDecayFraction: 0.001,
};
const observation = (
  id: string,
  atSeconds: number,
  candidate: number | null,
  np: number | null = 200,
): PowerObservation => ({
  id,
  atSeconds,
  durationSeconds: 3600,
  normalizedPowerWatts: np,
  candidate:
    candidate === null
      ? null
      : { watts: candidate, effort: { durationSeconds: 1200, watts: candidate + 15 } },
});

describe("reference-curve threshold algorithms", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0])(
    "rejects a non-finite or non-positive maximum duration %s",
    (maximumDurationSeconds) => {
      expect(() =>
        estimateThreshold([], curves, { ...thresholdPolicy, maximumDurationSeconds }),
      ).toThrow();
    },
  );

  it.each(["criticalPowerWatts", "workCapacityJoules", "timeOffsetSeconds"] as const)(
    "rejects zero %s in a supplied reference",
    (field) => {
      expect(() => modelPower({ ...curves[0], [field]: 0 }, 300)).toThrow();
    },
  );

  it("rejects reference families with equal target powers", () => {
    expect(() => estimateThreshold([], [curves[0], { ...curves[0] }], thresholdPolicy)).toThrow(
      "ordered",
    );
  });

  it("interpolates reference curves and predicts target power, not their CP asymptote", () => {
    const watts = (modelPower(curves[0], 300) + modelPower(curves[1], 300)) / 2;
    const expected = (modelPower(curves[0], 3600) + modelPower(curves[1], 3600)) / 2;
    const result = estimateThreshold([{ durationSeconds: 300, watts }], curves, thresholdPolicy);
    expect(result?.watts).toBeCloseTo(expected, 10);
    expect(result?.watts).toBeGreaterThan(230);
    expect(result?.effort.durationSeconds).toBe(300);
  });
  it("keeps unsupported durations and outside-bank powers unavailable", () => {
    expect(
      estimateThreshold([{ durationSeconds: 60, watts: 500 }], curves, thresholdPolicy),
    ).toBeNull();
    expect(
      estimateThreshold([{ durationSeconds: 300, watts: 900 }], curves, thresholdPolicy),
    ).toBeNull();
    expect(estimateThreshold([], curves, thresholdPolicy)).toBeNull();
  });
  it("chooses the strongest supported candidate and favors longer evidence on an exact tie", () => {
    const result = estimateThreshold(
      [
        { durationSeconds: 300, watts: modelPower(curves[0], 300) },
        { durationSeconds: 1200, watts: modelPower(curves[1], 1200) },
      ],
      curves,
      thresholdPolicy,
    );
    expect(result?.watts).toBeCloseTo(modelPower(curves[1], 3600), 10);
    expect(result?.effort.durationSeconds).toBe(1200);
  });
  it("rejects invalid or crossing reference curves", () => {
    expect(() =>
      estimateThreshold(
        [{ durationSeconds: 300, watts: 250 }],
        [...curves].reverse(),
        thresholdPolicy,
      ),
    ).toThrow("ordered");
    expect(() => modelPower({ ...curves[0], timeOffsetSeconds: -1 }, 300)).toThrow("positive");
  });
});

describe("chronological maintained thresholds", () => {
  it.each([
    { durationSeconds: 0, watts: 250 },
    { durationSeconds: Number.NaN, watts: 250 },
    { durationSeconds: Number.POSITIVE_INFINITY, watts: 250 },
    { durationSeconds: 300, watts: 0 },
    { durationSeconds: 300, watts: Number.NaN },
    { durationSeconds: 300, watts: Number.POSITIVE_INFINITY },
  ])("rejects invalid candidate effort evidence %j", (effort) => {
    const input = observation("a", 1, 240);
    input.candidate = { watts: 240, effort };
    expect(() => projectThresholdHistory([input], 2, historyPolicy)).toThrow();
  });

  it("retains generic identifiers and valid observations before the Unix epoch", () => {
    const history = projectThresholdHistory([observation("-1", -1, 240)], -1, historyPolicy);
    expect(history.find((point) => point.id === "-1")).toMatchObject({
      atSeconds: -1,
      thresholdWatts: 240,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite history endpoint %s",
    (asOfSeconds) => {
      expect(() => projectThresholdHistory([], asOfSeconds, historyPolicy)).toThrow();
    },
  );

  it("raises estimates and carries forward lower candidates without future leakage", () => {
    const observations = [
      observation("a", 1, 240),
      observation("b", 2, 180),
      observation("c", 3, 260),
    ];
    const result = projectThresholdHistory([...observations].reverse(), 3, historyPolicy).filter(
      (point) => point.id !== null,
    );
    expect(result.map((point) => point.thresholdWatts)).toEqual([240, 240, 260]);
    expect(result.map((point) => point.evidence?.id)).toEqual(["a", "a", "c"]);
    expect(result[0]?.trainingStressScore).toBeCloseTo((200 / 240) ** 2 * 100, 8);
    expect(projectThresholdHistory(observations, 2, historyPolicy).at(-1)?.thresholdWatts).toBe(
      240,
    );
  });
  it("uses deterministic ordering for equal timestamps", () => {
    const lowerEstimate = observation("a", 1, 240);
    const higherEstimate = observation("b", 1, 260);
    expect(projectThresholdHistory([higherEstimate, lowerEstimate], 1, historyPolicy)).toEqual(
      projectThresholdHistory([lowerEstimate, higherEstimate], 1, historyPolicy),
    );
  });

  it("keeps distinct opaque Unicode identifiers deterministic at the same timestamp", () => {
    const composedIdentifier = observation("\u00e9", 1, 240);
    const decomposedIdentifier = observation("e\u0301", 1, 240);
    const firstOrder = projectThresholdHistory(
      [composedIdentifier, decomposedIdentifier],
      1,
      historyPolicy,
    );
    const reversedOrder = projectThresholdHistory(
      [decomposedIdentifier, composedIdentifier],
      1,
      historyPolicy,
    );
    expect(firstOrder).toEqual(reversedOrder);
    expect(firstOrder.at(-1)?.evidence?.id).toBe("e\u0301");
  });
  it("holds with maintained training and declines gradually with known inactivity", () => {
    const observations = Array.from({ length: 42 }, (_, day) =>
      observation(`a${day}`, day * 86400 + 1, day === 0 ? 240 : null),
    );
    expect(
      projectThresholdHistory(observations, 42 * 86400, historyPolicy).at(-1)?.thresholdWatts,
    ).toBeCloseTo(240, 8);
    const inactive = projectThresholdHistory(
      observations.slice(0, 28),
      56 * 86400,
      historyPolicy,
    ).at(-1);
    expect(inactive?.thresholdWatts).toBeLessThan(240);
    expect(inactive?.thresholdWatts).toBeGreaterThan(225);
    expect(inactive?.evidence?.id).toBe("a0");
  });
  it("does not turn missing power into zero training", () => {
    const observations = Array.from({ length: 42 }, (_, day) =>
      observation(`a${day}`, day * 86400 + 1, day === 0 ? 240 : null, day < 28 ? 200 : null),
    );
    const history = projectThresholdHistory(observations, 42 * 86400, historyPolicy);
    expect(history.at(-1)?.thresholdWatts).toBeCloseTo(240, 8);
    expect(history.find((point) => point.id === "a30")?.trainingStressScore).toBeNull();
  });
  it("reconstructs history when old peak evidence changes or is deleted", () => {
    const later = observation("b", 2, 240);
    expect(
      projectThresholdHistory([observation("a", 1, 280), later], 2, historyPolicy).at(-1)
        ?.thresholdWatts,
    ).toBe(280);
    expect(
      projectThresholdHistory([observation("a", 1, 220), later], 2, historyPolicy).at(-1)
        ?.thresholdWatts,
    ).toBe(240);
    expect(projectThresholdHistory([later], 2, historyPolicy).at(-1)?.evidence?.id).toBe("b");
  });
  it("preserves unavailable initial state and validates supplied policy", () => {
    expect(projectThresholdHistory([], 10, historyPolicy)).toEqual([]);
    expect(
      projectThresholdHistory([observation("a", 1, null)], 10, historyPolicy).at(-1)
        ?.thresholdWatts,
    ).toBeNull();
    expect(() =>
      projectThresholdHistory([], 10, { ...historyPolicy, maximumDailyDecayFraction: 1 }),
    ).toThrow("decay");
  });
});
