import { describe, expect, it } from "vitest";
import { workoutActivityTypeMap } from "./health-kit-sync-schemas.ts";

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
