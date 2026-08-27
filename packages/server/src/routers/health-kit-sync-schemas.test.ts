import { describe, expect, it } from "vitest";
import {
  getDailyMetricAccumulatorKey,
  healthKitSampleSchema,
  workoutActivityTypeMap,
} from "./health-kit-sync-schemas.ts";

describe("healthKitSampleSchema", () => {
  const sample = {
    type: "HKCategoryTypeIdentifierMenstrualFlow",
    value: 2,
    unit: "category",
    startDate: "2026-08-01T08:00:00-07:00",
    endDate: "2026-08-01T08:05:00-07:00",
    sourceName: "Cycle Source",
    sourceBundle: "com.example.cycle-source",
    uuid: "91C7A825-3DA3-4F24-9085-15A9E2D1D2A1",
  };

  it("accepts flat string, number, and boolean metadata", () => {
    expect(
      healthKitSampleSchema.parse({
        ...sample,
        metadata: {
          HKMetadataKeyMenstrualCycleStart: true,
          upstreamVersion: 3,
          upstreamLabel: "confirmed",
        },
      }).metadata,
    ).toEqual({
      HKMetadataKeyMenstrualCycleStart: true,
      upstreamVersion: 3,
      upstreamLabel: "confirmed",
    });
  });

  it.each([
    { nested: { value: true } },
    { nested: ["value"] },
  ])("rejects non-scalar metadata values", (metadata) => {
    expect(() => healthKitSampleSchema.parse({ ...sample, metadata })).toThrow();
  });
});

describe("workoutActivityTypeMap", () => {
  // HKWorkoutActivityType rawValues from Apple documentation.
  // The map keys must match the numeric rawValue that the iOS native module sends.
  // Values must use snake_case canonical activity types matching the DB enum.
  const criticalMappings: Array<[string, string]> = [
    // Common types — these MUST be correct
    ["13", "cycling"],
    ["24", "hiking"],
    ["37", "running"],
    ["46", "swimming"],
    ["52", "walking"],
    ["57", "yoga"],

    // Types that were broken by the off-by-one shift (deprecated type gap at rawValue 15)
    ["16", "elliptical"],
    ["17", "equestrian"],
    ["20", "functional_strength"],
    ["23", "handball"],
    ["25", "hockey"],
    ["28", "martial_arts"],
    ["29", "mind_and_body"],

    // Types that were broken by the second shift (deprecated type gap at rawValue 30)
    ["31", "paddle_sports"],
    ["33", "preparation_and_recovery"],
    ["35", "rowing"],
    ["44", "stair_climbing"],
    ["49", "track_and_field"],
    ["50", "strength_training"],
    ["51", "volleyball"],

    // Newer types (after rawValue 57)
    ["58", "barre"],
    ["59", "core_training"],
    ["63", "hiit"],
    ["66", "pilates"],
    ["72", "tai_chi"],
    ["73", "mixed_cardio"],
    ["77", "cardio_dance"],
    ["78", "social_dance"],
    ["79", "pickleball"],
    ["80", "cooldown"],
  ];

  it.each(criticalMappings)("rawValue %s maps to canonical type %s", (rawValue, expectedType) => {
    expect(workoutActivityTypeMap[rawValue]).toBe(expectedType);
  });

  it("maps deprecated danceInspiredTraining (15) to dance", () => {
    expect(workoutActivityTypeMap["15"]).toBe("dance");
  });

  it("maps deprecated mixedMetabolicCardioTraining (30) to mixed_metabolic_cardio", () => {
    expect(workoutActivityTypeMap["30"]).toBe("mixed_metabolic_cardio");
  });

  it("all values use snake_case (no camelCase)", () => {
    for (const [rawValue, activityType] of Object.entries(workoutActivityTypeMap)) {
      expect(
        activityType,
        `rawValue ${rawValue} has camelCase value "${activityType}"`,
      ).not.toMatch(/[a-z][A-Z]/);
    }
  });
});

describe("getDailyMetricAccumulatorKey", () => {
  it("returns the accumulator key for a mapped daily metric column", () => {
    expect(getDailyMetricAccumulatorKey("walking_speed")).toBe("walkingSpeed");
  });

  it("throws when a daily metric column is missing an accumulator mapping", () => {
    expect(() => getDailyMetricAccumulatorKey("missing_daily_metric_column")).toThrow(
      "Missing daily metric accumulator mapping for column: missing_daily_metric_column",
    );
  });
});
