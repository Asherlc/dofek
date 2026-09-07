import { describe, expect, it } from "vitest";
import {
  type ActivityRepresentativeCandidate,
  activityRepresentativeRank,
  selectActivityRepresentative,
} from "./activity-representative.ts";

const baseCandidate: ActivityRepresentativeCandidate = {
  id: "00000000-0000-0000-0000-000000000001",
  canonicalType: "cardio",
  providerType: "cardio",
  providerPriority: 10,
  payload: {
    completeStrengthWorkingSetCount: 0,
    strengthSetCount: 0,
    strengthExerciseCount: 0,
    hasSensorData: false,
    sensorSampleCount: 0,
    hasLocationData: false,
    locationSampleCount: 0,
    hasElevation: false,
  },
};

function candidate(
  overrides: Partial<ActivityRepresentativeCandidate>,
): ActivityRepresentativeCandidate {
  return {
    ...baseCandidate,
    ...overrides,
    payload: {
      ...baseCandidate.payload,
      ...overrides.payload,
    },
  };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [Array.from(values)];

  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidateIndex) => candidateIndex !== index)).map(
      (remainder) => [value, ...remainder],
    ),
  );
}

describe("activity representative selection", () => {
  it("prefers a strength member with complete working sets to an empty WHOOP mirror", () => {
    const strong = candidate({
      id: "00000000-0000-0000-0000-000000000010",
      canonicalType: "strength",
      providerType: "strength_training",
      providerPriority: 50,
      payload: {
        ...baseCandidate.payload,
        completeStrengthWorkingSetCount: 5,
        strengthSetCount: 8,
        strengthExerciseCount: 2,
      },
    });
    const whoop = candidate({
      id: "00000000-0000-0000-0000-000000000020",
      canonicalType: "strength",
      providerType: "weightlifting",
      providerPriority: 1,
    });

    expect(selectActivityRepresentative([whoop, strong])).toBe(strong);
  });

  it("prefers a sensor-bearing member to a metadata-only member", () => {
    const metadataOnly = candidate({
      id: "00000000-0000-0000-0000-000000000010",
      providerPriority: 1,
    });
    const sensorBearing = candidate({
      id: "00000000-0000-0000-0000-000000000020",
      providerPriority: 50,
      payload: { ...baseCandidate.payload, hasSensorData: true, sensorSampleCount: 1 },
    });

    expect(selectActivityRepresentative([metadataOnly, sensorBearing])).toBe(sensorBearing);
  });

  it("prefers cycling to generic cardio", () => {
    const cardio = candidate({
      id: "00000000-0000-0000-0000-000000000010",
      canonicalType: "cardio",
      providerPriority: 1,
    });
    const cycling = candidate({
      id: "00000000-0000-0000-0000-000000000020",
      canonicalType: "cycling",
      providerType: "cycling",
      providerPriority: 50,
    });

    expect(selectActivityRepresentative([cardio, cycling])).toBe(cycling);
  });

  it('prefers providerType "commuting" to an unrefined cycling member', () => {
    const unrefined = candidate({
      id: "00000000-0000-0000-0000-000000000010",
      canonicalType: "cycling",
      providerType: "cycling",
      providerPriority: 1,
    });
    const commuting = candidate({
      id: "00000000-0000-0000-0000-000000000020",
      canonicalType: "cycling",
      providerType: "commuting",
      providerPriority: 50,
    });

    expect(activityRepresentativeRank(commuting)[9]).toBe(1);
    expect(activityRepresentativeRank(unrefined)[9]).toBe(0);
    expect(selectActivityRepresentative([unrefined, commuting])).toBe(commuting);
  });

  it("uses provider priority and UUID only after payload and classification tie", () => {
    const richerLowPriority = candidate({
      id: "00000000-0000-0000-0000-000000000030",
      providerPriority: 50,
      payload: { ...baseCandidate.payload, hasSensorData: true, sensorSampleCount: 1 },
    });
    const metadataHighPriority = candidate({
      id: "00000000-0000-0000-0000-000000000001",
      providerPriority: 1,
    });
    const priorityWinner = candidate({
      id: "00000000-0000-0000-0000-000000000020",
      providerPriority: 1,
    });
    const lowerPriority = candidate({
      id: "00000000-0000-0000-0000-000000000001",
      providerPriority: 50,
    });
    const uuidWinner = candidate({
      id: "00000000-0000-0000-0000-000000000010",
      providerPriority: 1,
    });

    expect(selectActivityRepresentative([metadataHighPriority, richerLowPriority])).toBe(
      richerLowPriority,
    );
    expect(selectActivityRepresentative([lowerPriority, priorityWinner])).toBe(priorityWinner);
    expect(selectActivityRepresentative([priorityWinner, uuidWinner])).toBe(uuidWinner);
  });

  it("selects the same representative for every input permutation", () => {
    const members = [
      candidate({ id: "00000000-0000-0000-0000-000000000001" }),
      candidate({
        id: "00000000-0000-0000-0000-000000000002",
        canonicalType: "cycling",
        providerType: "cycling",
      }),
      candidate({
        id: "00000000-0000-0000-0000-000000000003",
        canonicalType: "cycling",
        providerType: "commuting",
      }),
      candidate({
        id: "00000000-0000-0000-0000-000000000004",
        canonicalType: "cycling",
        providerType: "commuting",
        payload: { ...baseCandidate.payload, hasSensorData: true, sensorSampleCount: 100 },
      }),
    ];

    for (const permutation of permutations(members)) {
      expect(selectActivityRepresentative(permutation)?.id).toBe(
        "00000000-0000-0000-0000-000000000004",
      );
    }
  });

  it("returns the documented rank tuple", () => {
    expect(
      activityRepresentativeRank(
        candidate({
          id: "member-id",
          canonicalType: "cycling",
          providerType: " commuting ",
          providerPriority: 7,
          payload: {
            completeStrengthWorkingSetCount: 6,
            strengthSetCount: 8,
            strengthExerciseCount: 2,
            hasSensorData: true,
            sensorSampleCount: 100,
            hasLocationData: true,
            locationSampleCount: 50,
            hasElevation: true,
          },
        }),
      ),
    ).toEqual([6, 8, 2, 1, 100, 1, 50, 1, 1, 1, 7, "member-id"]);
    expect(activityRepresentativeRank(baseCandidate)).toEqual([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      10,
      "00000000-0000-0000-0000-000000000001",
    ]);
  });

  it("treats other as generic and null, blank, or canonical provider types as unrefined", () => {
    for (const providerType of [null, "", "   ", "CYCLING"]) {
      const rank = activityRepresentativeRank(
        candidate({ canonicalType: "cycling", providerType }),
      );
      expect(rank[9]).toBe(0);
    }

    expect(activityRepresentativeRank(candidate({ canonicalType: "other" }))[8]).toBe(0);
  });

  it("compares every payload richness field before provider priority", () => {
    const payloadAdvantages: ActivityRepresentativeCandidate["payload"][] = [
      { ...baseCandidate.payload, completeStrengthWorkingSetCount: 1 },
      { ...baseCandidate.payload, strengthSetCount: 1 },
      { ...baseCandidate.payload, strengthExerciseCount: 1 },
      { ...baseCandidate.payload, hasSensorData: true },
      { ...baseCandidate.payload, sensorSampleCount: 2, hasSensorData: true },
      { ...baseCandidate.payload, hasLocationData: true },
      { ...baseCandidate.payload, locationSampleCount: 2, hasLocationData: true },
      { ...baseCandidate.payload, hasElevation: true },
    ];
    const highPriority = candidate({ providerPriority: 1 });

    for (const [index, payload] of payloadAdvantages.entries()) {
      const richer = candidate({
        id: `00000000-0000-0000-0000-${String(index + 10).padStart(12, "0")}`,
        payload,
        providerPriority: 50,
      });
      expect(selectActivityRepresentative([highPriority, richer])).toBe(richer);
    }
  });

  it("returns null for no candidates and preserves the first of exactly equal ranks", () => {
    const first = { ...baseCandidate, label: "first" };
    const second = { ...baseCandidate, label: "second" };

    expect(selectActivityRepresentative([])).toBeNull();
    expect(selectActivityRepresentative([first, second])).toBe(first);
  });
});
