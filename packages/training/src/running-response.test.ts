import { describe, expect, it } from "vitest";
import {
  runningDynamicsResponseSchema,
  runningDynamicsResponseV2Schema,
  runningDynamicsRowsResponseSchema,
  runningResponseVersionSchema,
  toRunningDynamicsRowsV1,
} from "./running-response.ts";

const row = {
  activityId: "run",
  date: "2026-10-01",
  activityName: "Run",
  cadence: 170,
  cadenceBasis: "step_intervals" as const,
  cadenceObservedSeconds: 180,
  cadenceCoveragePercent: 30,
  strideLengthMeters: null,
  stanceTimeMs: 240,
  verticalOscillationMm: null,
  paceSecondsPerKm: 300,
  distanceKm: 5,
};
const availability = {
  status: "available" as const,
  sourceLabel: "Running",
  observedCount: 1,
  minimumCount: 1,
  message: "Available",
};
const response = { data: [row], availability, cadenceAvailability: availability };
describe("running wire contract", () => {
  it("defaults to legacy and accepts only supported response versions", () => {
    expect(runningResponseVersionSchema.parse(undefined)).toBe(1);
    expect(runningResponseVersionSchema.parse(2)).toBe(2);
    for (const value of [0, 3, "2", null])
      expect(runningResponseVersionSchema.safeParse(value).success).toBe(false);
  });
  it("retains current metadata through current-first whole-response unions", () => {
    expect(runningDynamicsRowsResponseSchema.parse([row])).toEqual([row]);
    expect(runningDynamicsResponseSchema.parse(response)).toEqual(response);
    expect(runningDynamicsResponseV2Schema.parse(response)).toEqual(response);
  });
  it("projects exactly historical fields without mutating canonical input and preserves zero", () => {
    const zero = { ...row, cadence: 0, paceSecondsPerKm: 0, distanceKm: 0 };
    const snapshot = structuredClone(zero);
    const projected = toRunningDynamicsRowsV1([zero]);
    expect(projected).toEqual([
      {
        activityId: "run",
        date: "2026-10-01",
        activityName: "Run",
        cadence: 0,
        paceSecondsPerKm: 0,
        distanceKm: 0,
        strideLengthMeters: null,
        stanceTimeMs: 240,
        verticalOscillationMm: null,
      },
    ]);
    expect(zero).toEqual(snapshot);
    expect(runningDynamicsRowsResponseSchema.parse(projected)).toEqual(projected);
    expect(runningDynamicsResponseSchema.parse({ data: projected, availability })).toEqual({
      data: projected,
      availability,
    });
    expect(
      runningDynamicsResponseV2Schema.safeParse({ data: projected, availability }).success,
    ).toBe(false);
  });
  it.each(["cadence", "paceSecondsPerKm", "distanceKm"] as const)(
    "omits partial legacy rows with null %s",
    (key) => {
      const partial = { ...row, [key]: null };
      expect(toRunningDynamicsRowsV1([row, partial])).toHaveLength(1);
      expect(runningDynamicsRowsResponseSchema.parse([partial])).toEqual([partial]);
    },
  );
  it.each([Infinity, -Infinity, NaN, "170", undefined])(
    "rejects nonfinite, nonnumeric and missing measurements %s",
    (value) => {
      for (const key of ["cadence", "paceSecondsPerKm", "distanceKm"]) {
        const invalid = { ...row };
        Reflect.set(invalid, key, value);
        expect(toRunningDynamicsRowsV1([invalid])).toEqual([]);
      }
      for (const key of [
        "cadence",
        "paceSecondsPerKm",
        "distanceKm",
        "cadenceObservedSeconds",
        "cadenceCoveragePercent",
        "strideLengthMeters",
        "stanceTimeMs",
        "verticalOscillationMm",
      ]) {
        expect(
          runningDynamicsRowsResponseSchema.safeParse([{ ...row, [key]: value }]).success,
        ).toBe(false);
      }
    },
  );
  it("does not downgrade malformed current metadata to legacy", () => {
    for (const malformed of [
      { ...row, cadenceBasis: "bad" },
      { ...row, cadenceCoveragePercent: "30" },
      { ...row, cadenceObservedSeconds: undefined },
    ]) {
      expect(runningDynamicsRowsResponseSchema.safeParse([malformed]).success).toBe(false);
      expect(
        runningDynamicsResponseSchema.safeParse({ ...response, data: [malformed] }).success,
      ).toBe(false);
    }
    expect(
      runningDynamicsResponseSchema.safeParse({
        ...response,
        cadenceAvailability: { status: "bad" },
      }).success,
    ).toBe(false);
  });
  it("accepts empty arrays and requires complete valid current availability", () => {
    expect(runningDynamicsRowsResponseSchema.parse([])).toEqual([]);
    expect(runningDynamicsResponseV2Schema.safeParse({ ...response, data: [] }).success).toBe(true);
    for (const data of [
      null,
      { data: [], availability },
      { ...response, availability: { ...availability, observedCount: -1 } },
    ]) {
      expect(runningDynamicsResponseV2Schema.safeParse(data).success).toBe(false);
    }
    expect(
      runningDynamicsRowsResponseSchema.safeParse([{ ...row, date: "not-a-date" }]).success,
    ).toBe(false);
    expect(
      runningDynamicsRowsResponseSchema.safeParse([row, ...toRunningDynamicsRowsV1([row])]).success,
    ).toBe(false);
  });
});
