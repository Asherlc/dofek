import { describe, expect, it } from "vitest";
import { type DirectWeightObservation, selectNearbyWeight } from "./nearby-weight.ts";

function measured(
  date: string,
  valueKg: number,
  overrides: Partial<DirectWeightObservation> = {},
): DirectWeightObservation {
  return {
    date,
    measurementKind: "direct",
    observationType: "body_weight",
    provider: "withings",
    recordedAt: `${date}T08:00:00.000Z`,
    sourceRecordId: `weight-${date}`,
    valueKg,
    ...overrides,
  };
}

describe("selectNearbyWeight", () => {
  it("uses the latest valid same-day measured weight", () => {
    const result = selectNearbyWeight("2026-06-15", [
      measured("2026-06-15", 70, { recordedAt: "2026-06-15T07:00:00.000Z" }),
      measured("2026-06-15", 71, { recordedAt: "2026-06-15T09:00:00.000Z" }),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      distance_days: 0,
      kind: "measured",
      method: "same_day",
      quality: "high",
      value_kg: 71,
    });
  });

  it("interpolates between two measurements within fourteen days", () => {
    const result = selectNearbyWeight("2026-06-15", [
      measured("2026-06-10", 70),
      measured("2026-06-20", 72),
    ]);

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      distance_days: 5,
      kind: "interpolated",
      method: "linear_interpolation",
      quality: "medium",
      value_kg: 71,
    });
    if (!("sources" in result)) throw new Error("Expected interpolated weight evidence");
    expect(result.sources).toHaveLength(2);
  });

  it("uses a one-sided nearest measurement within thirty days", () => {
    expect(selectNearbyWeight("2026-06-15", [measured("2026-05-20", 69)])).toMatchObject({
      distance_days: 26,
      kind: "nearest",
      method: "nearest_within_30_days",
      quality: "low",
      value_kg: 69,
    });
  });

  it("prefers the earlier measurement when nearest dates tie", () => {
    const result = selectNearbyWeight("2026-06-15", [
      measured("2026-05-26", 70),
      measured("2026-07-05", 72),
    ]);

    if (!("sources" in result)) throw new Error("Expected nearest weight evidence");
    expect(result).toMatchSnapshot();
    expect(result.sources[0]?.date).toBe("2026-05-26");
  });

  it("returns an explicit reason when no valid nearby weight exists", () => {
    expect(selectNearbyWeight("2026-06-15", [measured("2026-05-01", 70)])).toEqual({
      reason: "No directly measured body weight within 30 days of the effort",
      value_kg: null,
    });
    expect(selectNearbyWeight("2026-06-15", [measured("2026-06-14", 0)])).toEqual({
      reason: "No valid positive directly measured body weight is available",
      value_kg: null,
    });
  });

  it("does not treat consumer BIA composition estimates as body weight", () => {
    const observations = [
      measured("2026-06-15", 12, {
        measurementKind: "estimated",
        observationType: "body_fat",
      }),
      measured("2026-06-15", 55, {
        measurementKind: "estimated",
        observationType: "lean_mass",
      }),
    ];

    expect(selectNearbyWeight("2026-06-15", observations)).toEqual({
      reason: "No valid positive directly measured body weight is available",
      value_kg: null,
    });
  });
});
