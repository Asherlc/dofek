import { beforeEach, describe, expect, it, vi } from "vitest";
import { hangTenContactMetadata, hangTenWorkout } from "./test-helpers.ts";

let applyWorkoutMetadata: typeof import("./workouts.ts").applyWorkoutMetadata;

beforeEach(async () => {
  // Exercise schema initialization alongside the payload validation assertions.
  vi.resetModules();
  ({ applyWorkoutMetadata } = await import("./workouts.ts"));
});

describe("Hang Ten contact activity metadata", () => {
  it.each([
    { contactID: "edge-25-left", selection: "single" },
    { kind: "edge", depth: { range: { minimum: 20, maximum: 25 } }, selection: "bilateralPair" },
    { kind: "jug", depth: { category: "large" }, selection: "single" },
  ])("preserves supported contact requirement variants: %j", (requirement) => {
    const workout = applyWorkoutMetadata(hangTenWorkout(), {
      ...hangTenContactMetadata(),
      "HangTen.ActivitySegments.v2": JSON.stringify({
        version: 3,
        segments: [
          {
            stepID: "contact-hang",
            stepNumber: 1,
            kind: "work",
            durationSeconds: 7,
            target: {
              kind: "resolvedContacts",
              resolution: {
                boardID: "board",
                revisionID: "revision",
                contactIDs: ["edge-25-left"],
                requirement,
              },
            },
          },
        ],
      }),
    });

    expect(workout.hangTen?.activitySegments).toHaveLength(1);
    expect(workout.hangTen?.activitySegments?.[0]?.target).toMatchObject({
      resolution: { requirement },
    });
  });

  it.each([
    {
      description: "missing contact identifiers",
      resolution: { boardID: "board", revisionID: "revision", requirement: {} },
    },
    {
      description: "an invalid requirement kind",
      resolution: {
        boardID: "board",
        revisionID: "revision",
        contactIDs: ["edge-25-left"],
        requirement: { kind: 25 },
      },
    },
    {
      description: "an incomplete depth range",
      resolution: {
        boardID: "board",
        revisionID: "revision",
        contactIDs: ["edge-25-left"],
        requirement: { depth: { range: { minimum: 25 } } },
      },
    },
  ])("reports contact targets with $description", ({ resolution }) => {
    const workout = applyWorkoutMetadata(hangTenWorkout(), {
      "HangTen.PlanName": "Repeaters",
      "HangTen.ActivitySegments.v2": JSON.stringify({
        version: 3,
        segments: [
          {
            stepID: "invalid-target",
            stepNumber: 1,
            kind: "work",
            target: { kind: "resolvedContacts", resolution },
          },
        ],
      }),
    });

    expect(workout.hangTen?.activitySegments).toBeUndefined();
    expect(workout.hangTen?.activitySegmentsError).toContain("invalid fields");
  });

  it.each([undefined, 1])(
    "reports legacy segments without hold identifiers in format version %s",
    (version) => {
      const workout = applyWorkoutMetadata(hangTenWorkout(), {
        "HangTen.PlanName": "Repeaters",
        "HangTen.ActivitySegments": JSON.stringify({
          version,
          segments: [{ stepID: "missing-holds", stepNumber: 1, kind: "work" }],
        }),
      });

      expect(workout.hangTen?.activitySegments).toBeUndefined();
      expect(workout.hangTen?.activitySegmentsError).toContain("invalid fields");
    },
  );

  it.each([2, 3])("imports all recorded intervals from format version %i", (version) => {
    const metadata = hangTenContactMetadata(version);
    const workout = applyWorkoutMetadata(hangTenWorkout(), metadata);

    expect(workout.hangTen?.activitySegmentsError).toBeUndefined();
    expect(workout.hangTen?.rawActivitySegments).toBe(metadata["HangTen.ActivitySegments.v2"]);
    expect(workout.hangTen?.activitySegments).toHaveLength(39);
    expect(workout.hangTen?.activitySegments?.[0]).toMatchObject({
      stepID: "round-1-hang-1",
      kind: "work",
      durationSeconds: 7,
      target: {
        kind: "resolvedContacts",
        resolution: { contactIDs: ["edge-25-left", "edge-25-right"] },
      },
    });
    if (version === 3) {
      expect(workout.hangTen?.activitySegments?.[0]).toMatchObject({
        handUse: "double",
        side: "both",
      });
    }
    expect(workout.hangTen?.activitySegments?.at(-1)).toMatchObject({
      kind: "rest",
      stepNumber: 39,
      durationSeconds: 7.341392541668029,
    });
  });

  it("uses current metadata when a workout also contains older segment metadata", () => {
    const workout = applyWorkoutMetadata(hangTenWorkout(), {
      ...hangTenContactMetadata(),
      "HangTen.ActivitySegments": JSON.stringify({ version: 1, segments: [] }),
    });

    expect(workout.hangTen?.activitySegments).toHaveLength(39);
  });

  it("reports malformed current metadata without substituting older segments", () => {
    const workout = applyWorkoutMetadata(hangTenWorkout(), {
      ...hangTenContactMetadata(),
      "HangTen.ActivitySegments.v2": "{invalid",
      "HangTen.ActivitySegments": JSON.stringify({ version: 1, segments: [] }),
    });

    expect(workout.hangTen?.rawActivitySegments).toBe("{invalid");
    expect(workout.hangTen?.activitySegments).toBeUndefined();
    expect(workout.hangTen?.activitySegmentsError).toContain("could not parse JSON");
  });

  it("imports self-selected work and rest without inventing contact identifiers", () => {
    const workout = applyWorkoutMetadata(hangTenWorkout(), {
      ...hangTenContactMetadata(),
      "HangTen.ActivitySegments.v2": JSON.stringify({
        version: 3,
        segments: [
          {
            stepID: "free-hang",
            stepNumber: 1,
            kind: "work",
            target: { kind: "selfSelected" },
            durationSeconds: 10,
          },
          { stepID: "rest", stepNumber: 2, kind: "rest", durationSeconds: 20 },
        ],
      }),
    });

    expect(workout.hangTen?.activitySegments).toEqual([
      {
        stepID: "free-hang",
        stepNumber: 1,
        kind: "work",
        target: { kind: "selfSelected" },
        durationSeconds: 10,
      },
      { stepID: "rest", stepNumber: 2, kind: "rest", durationSeconds: 20 },
    ]);
  });

  it("reports work segments that lack the recorded contact target", () => {
    const workout = applyWorkoutMetadata(hangTenWorkout(), {
      ...hangTenContactMetadata(),
      "HangTen.ActivitySegments.v2": JSON.stringify({
        version: 3,
        segments: [{ stepID: "missing-target", stepNumber: 1, kind: "work", durationSeconds: 7 }],
      }),
    });

    expect(workout.hangTen?.activitySegments).toBeUndefined();
    expect(workout.hangTen?.activitySegmentsError).toContain("invalid fields");
  });
});
