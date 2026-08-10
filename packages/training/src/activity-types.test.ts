import { describe, expect, it } from "vitest";
import {
  ACTIVITY_MODALITIES,
  CANONICAL_ACTIVITY_TYPES,
  classifyLegacyActivityType,
  LEGACY_ACTIVITY_TYPES,
  resolveProviderActivityType,
  resolveRawProviderActivityType,
} from "./activity-types.ts";

interface ExpectedLegacyClassification {
  legacyType: (typeof LEGACY_ACTIVITY_TYPES)[number];
  canonicalType: (typeof CANONICAL_ACTIVITY_TYPES)[number];
  modality: (typeof ACTIVITY_MODALITIES)[number] | null;
}

const EXPECTED_LEGACY_CLASSIFICATIONS = [
  ["cycling", "cycling", null],
  ["road_cycling", "cycling", "road"],
  ["mountain_biking", "cycling", "mountain"],
  ["gravel_cycling", "cycling", "gravel"],
  ["indoor_cycling", "cycling", "indoor"],
  ["virtual_cycling", "cycling", "virtual"],
  ["e_bike_cycling", "cycling", "electric"],
  ["cyclocross", "cycling", "cyclocross"],
  ["track_cycling", "cycling", "track"],
  ["bmx", "cycling", "bmx"],
  ["running", "running", null],
  ["trail_running", "running", "trail"],
  ["swimming", "swimming", null],
  ["open_water_swimming", "swimming", "open_water"],
  ["walking", "walking", null],
  ["hiking", "hiking", null],
  ["strength", "strength", null],
  ["strength_training", "strength", null],
  ["functional_strength", "strength", "functional"],
  ["gym", "strength", null],
  ["yoga", "yoga", null],
  ["pilates", "pilates", null],
  ["tai_chi", "tai_chi", null],
  ["mind_and_body", "mind_and_body", null],
  ["meditation", "meditation", null],
  ["breathwork", "breathwork", null],
  ["stretching", "stretching", null],
  ["flexibility", "stretching", null],
  ["barre", "barre", null],
  ["elliptical", "elliptical", null],
  ["rowing", "rowing", null],
  ["cardio", "cardio", null],
  ["hiit", "hiit", null],
  ["mixed_cardio", "cardio", "mixed"],
  ["mixed_metabolic_cardio", "cardio", "mixed_metabolic"],
  ["stair_climbing", "stair_climbing", null],
  ["stairmaster", "stair_climbing", null],
  ["stairs", "stair_climbing", null],
  ["step_training", "step_training", null],
  ["jump_rope", "jump_rope", null],
  ["fitness_gaming", "fitness_gaming", null],
  ["cross_training", "cross_training", null],
  ["bootcamp", "bootcamp", null],
  ["circuit_training", "circuit_training", null],
  ["functional_fitness", "strength", "functional"],
  ["core", "core", null],
  ["core_training", "core", null],
  ["boxing", "boxing", null],
  ["kickboxing", "kickboxing", null],
  ["martial_arts", "martial_arts", null],
  ["group_exercise", "group_exercise", null],
  ["skiing", "skiing", null],
  ["cross_country_skiing", "skiing", "cross_country"],
  ["downhill_skiing", "skiing", "downhill"],
  ["snowboarding", "snowboarding", null],
  ["snow_sports", "snow_sports", null],
  ["snowshoeing", "snowshoeing", null],
  ["skating", "skating", null],
  ["surfing", "surfing", null],
  ["kayaking", "kayaking", null],
  ["sailing", "sailing", null],
  ["paddle_sports", "paddling", null],
  ["paddleboarding", "paddling", "paddleboard"],
  ["paddling", "paddling", null],
  ["water_fitness", "water_fitness", null],
  ["water_polo", "water_polo", null],
  ["water_sports", "water_sports", null],
  ["aqua_fitness", "water_fitness", null],
  ["underwater_diving", "diving", null],
  ["diving", "diving", null],
  ["snorkeling", "snorkeling", null],
  ["tennis", "tennis", null],
  ["table_tennis", "table_tennis", null],
  ["squash", "squash", null],
  ["racquetball", "racquetball", null],
  ["badminton", "badminton", null],
  ["pickleball", "pickleball", null],
  ["padel", "padel", null],
  ["paddle_racquet", "pickleball", null],
  ["basketball", "basketball", null],
  ["soccer", "soccer", null],
  ["football", "american_football", null],
  ["american_football", "american_football", null],
  ["australian_football", "australian_football", null],
  ["rugby", "rugby", null],
  ["hockey", "hockey", null],
  ["ice_hockey", "hockey", "ice"],
  ["lacrosse", "lacrosse", null],
  ["baseball", "baseball", null],
  ["softball", "softball", null],
  ["volleyball", "volleyball", null],
  ["cricket", "cricket", null],
  ["handball", "handball", null],
  ["golf", "golf", null],
  ["disc_golf", "disc_golf", null],
  ["climbing", "climbing", null],
  ["rock_climbing", "climbing", null],
  ["dance", "dance", null],
  ["dancing", "dance", null],
  ["cardio_dance", "dance", "cardio"],
  ["social_dance", "dance", "social"],
  ["triathlon", "triathlon", null],
  ["multisport", "multisport", null],
  ["hand_cycling", "cycling", "hand_cycle"],
  ["wheelchair_walk", "walking", "wheelchair"],
  ["wheelchair_run", "running", "wheelchair"],
  ["disc_sports", "disc_sports", null],
  ["equestrian", "equestrian", null],
  ["fencing", "fencing", null],
  ["fishing", "fishing", null],
  ["hunting", "hunting", null],
  ["gymnastics", "gymnastics", null],
  ["archery", "archery", null],
  ["bowling", "bowling", null],
  ["curling", "curling", null],
  ["wrestling", "wrestling", null],
  ["track_and_field", "track_and_field", null],
  ["play", "play", null],
  ["navigation", "navigation", null],
  ["geocaching", "geocaching", null],
  ["skydiving", "skydiving", null],
  ["paragliding", "paragliding", null],
  ["preparation_and_recovery", "preparation_and_recovery", null],
  ["cooldown", "preparation_and_recovery", "cooldown"],
  ["transition", "transition", null],
  ["other", "other", null],
] as const satisfies readonly (readonly [
  ExpectedLegacyClassification["legacyType"],
  ExpectedLegacyClassification["canonicalType"],
  ExpectedLegacyClassification["modality"],
])[];

describe("legacy activity classification", () => {
  it("covers every legacy enum value exactly once", () => {
    const expectedLegacyTypes = EXPECTED_LEGACY_CLASSIFICATIONS.map(([legacyType]) => legacyType);

    expect(expectedLegacyTypes).toHaveLength(126);
    expect(new Set(expectedLegacyTypes).size).toBe(expectedLegacyTypes.length);
    expect(expectedLegacyTypes).toEqual(LEGACY_ACTIVITY_TYPES);
  });

  it("maps every legacy value to the agreed canonical type and modality", () => {
    for (const [legacyType, canonicalType, modality] of EXPECTED_LEGACY_CLASSIFICATIONS) {
      expect(classifyLegacyActivityType(legacyType)).toEqual({ canonicalType, modality });
    }
  });

  it("only produces declared canonical values and modalities", () => {
    for (const legacyType of LEGACY_ACTIVITY_TYPES) {
      const result = classifyLegacyActivityType(legacyType);
      expect(CANONICAL_ACTIVITY_TYPES).toContain(result.canonicalType);
      if (result.modality !== null) {
        expect(ACTIVITY_MODALITIES).toContain(result.modality);
      }
    }
  });
});

describe("resolveProviderActivityType", () => {
  it("preserves the canonical hangboard activity type", () => {
    expect(CANONICAL_ACTIVITY_TYPES).toContain("hangboard");
    expect(resolveProviderActivityType("Hang Ten", "hangboard")).toMatchObject({
      canonicalType: "hangboard",
      providerType: "Hang Ten",
    });
  });

  it("retains string provider types verbatim", () => {
    expect(resolveProviderActivityType("Ride", "road_cycling")).toEqual({
      canonicalType: "cycling",
      providerType: "Ride",
      modality: "road",
    });
  });

  it("stringifies numeric provider types without changing their meaning", () => {
    expect(resolveProviderActivityType(97, "indoor_cycling")).toEqual({
      canonicalType: "cycling",
      providerType: "97",
      modality: "indoor",
    });
  });

  it("retains unknown provider types while classifying them as other", () => {
    expect(resolveProviderActivityType("Vendor Mystery")).toEqual({
      canonicalType: "other",
      providerType: "Vendor Mystery",
      modality: null,
    });
  });

  it("rejects blank provider types after trimming", () => {
    expect(() => resolveProviderActivityType("   ", "cycling")).toThrow(
      "Provider activity type must be non-empty",
    );
  });

  it("supports distinct canonical concepts absent from the legacy enum", () => {
    expect(resolveProviderActivityType("gaelic-football", "gaelic_football")).toEqual({
      canonicalType: "gaelic_football",
      providerType: "gaelic-football",
      modality: null,
    });
  });
});

describe("resolveRawProviderActivityType", () => {
  it("classifies known legacy values while preserving the exact provider string", () => {
    expect(resolveRawProviderActivityType("trail_running")).toEqual({
      canonicalType: "running",
      providerType: "trail_running",
      modality: "trail",
    });
  });

  it("classifies unknown provider strings as other without rewriting them", () => {
    expect(resolveRawProviderActivityType("Zepp Outdoor Workout")).toEqual({
      canonicalType: "other",
      providerType: "Zepp Outdoor Workout",
      modality: null,
    });
  });
});
