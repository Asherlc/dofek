import { describe, expect, it } from "vitest";
import {
  muscleGroupLabel,
  type RecommendationInput,
  recommendNextWorkout,
} from "./workout-recommendation.ts";

function makeInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    today: "2026-03-19",
    readinessScore: 75,
    workloadRatio: 1.0,
    trainingStressBalance: 0,
    sleepDebtMinutes: 0,
    recentActivities: [],
    zoneDistribution: null,
    muscleGroupFreshness: [],
    userMaxHr: 190,
    userRestingHr: 55,
    ...overrides,
  };
}

describe("recommendNextWorkout", () => {
  describe("readiness gating", () => {
    it("recommends rest when readiness is very low (<33)", () => {
      const result = recommendNextWorkout(makeInput({ readinessScore: 25 }));
      expect(result.type).toBe("rest");
      expect(result.summary).toBe("Rest Day");
      expect(result.reasoning.some((r) => r.includes("25/100"))).toBe(true);
    });

    it("mentions sleep debt in rest reasoning when significant", () => {
      const result = recommendNextWorkout(makeInput({ readinessScore: 20, sleepDebtMinutes: 240 }));
      expect(result.type).toBe("rest");
      expect(result.reasoning.some((r) => r.includes("Sleep debt"))).toBe(true);
    });

    it("recommends active recovery when readiness is low (33-49)", () => {
      const result = recommendNextWorkout(makeInput({ readinessScore: 40 }));
      expect(result.type).toBe("active_recovery");
      expect(result.summary).toContain("Active Recovery");
      expect(result.cardioEasyDetail).not.toBeNull();
      expect(result.cardioEasyDetail?.targetZone).toBe(1);
      expect(result.cardioEasyDetail?.durationMinutes).toBe(30);
    });

    it("recommends active recovery when workload ratio is dangerously high", () => {
      const result = recommendNextWorkout(makeInput({ workloadRatio: 1.7 }));
      expect(result.type).toBe("active_recovery");
      expect(result.reasoning.some((r) => r.includes("injury risk"))).toBe(true);
    });

    it("proceeds with normal recommendation when readiness is null (insufficient data)", () => {
      const result = recommendNextWorkout(makeInput({ readinessScore: null }));
      // Should not recommend rest/recovery just because data is missing
      expect(result.type).not.toBe("rest");
    });
  });

  describe("hard/easy alternation", () => {
    it("recommends easy cardio after a hard day with moderate readiness", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 60,
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
        }),
      );
      expect(result.type).toBe("cardio_easy");
      expect(result.reasoning.some((r) => r.includes("Yesterday was a hard"))).toBe(true);
    });

    it("allows harder training after a hard day if readiness is good", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 80,
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
          muscleGroupFreshness: [
            { muscleGroup: "chest", lastWorkedDate: "2026-03-14", setsThisWeek: 4 },
            { muscleGroup: "shoulders", lastWorkedDate: "2026-03-14", setsThisWeek: 3 },
            { muscleGroup: "triceps", lastWorkedDate: "2026-03-14", setsThisWeek: 3 },
          ],
        }),
      );
      // With good readiness and cardio yesterday, should alternate to strength
      expect(result.type).not.toBe("rest");
      expect(result.type).not.toBe("active_recovery");
    });
  });

  describe("strength vs cardio selection", () => {
    it("recommends strength when overdue (3+ days)", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: [],
              activityType: "running",
            },
            {
              type: "strength",
              date: "2026-03-15",
              wasHardDay: true,
              muscleGroups: ["chest", "shoulders"],
              activityType: "strength",
            },
          ],
          muscleGroupFreshness: [
            { muscleGroup: "back", lastWorkedDate: "2026-03-14", setsThisWeek: 6 },
            { muscleGroup: "biceps", lastWorkedDate: "2026-03-14", setsThisWeek: 4 },
            { muscleGroup: "lats", lastWorkedDate: "2026-03-14", setsThisWeek: 5 },
          ],
        }),
      );
      expect(result.type).toBe("strength");
      expect(result.reasoning.some((r) => r.includes("4 days ago"))).toBe(true);
    });

    it("recommends cardio when overdue (2+ days)", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "strength",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: ["chest", "shoulders"],
              activityType: "strength",
            },
            {
              type: "cardio",
              date: "2026-03-16",
              wasHardDay: false,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
        }),
      );
      expect(["cardio_easy", "cardio_intervals"]).toContain(result.type);
    });

    it("alternates to strength after cardio session", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
          muscleGroupFreshness: [
            { muscleGroup: "chest", lastWorkedDate: "2026-03-16", setsThisWeek: 4 },
            { muscleGroup: "shoulders", lastWorkedDate: "2026-03-16", setsThisWeek: 3 },
            { muscleGroup: "triceps", lastWorkedDate: "2026-03-16", setsThisWeek: 3 },
          ],
        }),
      );
      expect(result.type).toBe("strength");
    });

    it("alternates to cardio after strength session", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "strength",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: ["chest"],
              activityType: "strength",
            },
          ],
        }),
      );
      expect(["cardio_easy", "cardio_intervals"]).toContain(result.type);
    });
  });

  describe("muscle group selection", () => {
    it("excludes muscle groups worked less than 48 hours ago", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: [],
              activityType: "running",
            },
            {
              type: "strength",
              date: "2026-03-14",
              wasHardDay: true,
              muscleGroups: ["chest"],
              activityType: "strength",
            },
          ],
          muscleGroupFreshness: [
            // Worked today — should be excluded
            { muscleGroup: "chest", lastWorkedDate: "2026-03-18", setsThisWeek: 8 },
            // Worked 3 days ago — should be included
            { muscleGroup: "back", lastWorkedDate: "2026-03-16", setsThisWeek: 6 },
            { muscleGroup: "biceps", lastWorkedDate: "2026-03-16", setsThisWeek: 4 },
          ],
        }),
      );
      expect(result.type).toBe("strength");
      expect(result.strengthDetail?.muscleGroups).not.toContain("chest");
      expect(result.strengthDetail?.muscleGroups).toContain("back");
    });

    it("groups push muscles together", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: [],
              activityType: "cycling",
            },
            {
              type: "strength",
              date: "2026-03-14",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "strength",
            },
          ],
          muscleGroupFreshness: [
            { muscleGroup: "chest", lastWorkedDate: "2026-03-15", setsThisWeek: 4 },
            { muscleGroup: "shoulders", lastWorkedDate: "2026-03-15", setsThisWeek: 3 },
            { muscleGroup: "triceps", lastWorkedDate: "2026-03-15", setsThisWeek: 3 },
            { muscleGroup: "back", lastWorkedDate: "2026-03-15", setsThisWeek: 6 },
            { muscleGroup: "biceps", lastWorkedDate: "2026-03-15", setsThisWeek: 4 },
          ],
        }),
      );
      expect(result.type).toBe("strength");
      // Should pick one natural group, not all muscles randomly
      const groups = result.strengthDetail?.muscleGroups ?? [];
      const hasPush =
        groups.includes("chest") && groups.includes("shoulders") && groups.includes("triceps");
      const hasPull = groups.includes("back") && groups.includes("biceps");
      // Should be one coherent group, not both
      expect(hasPush || hasPull).toBe(true);
    });

    it("includes core with the main group when available", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: [],
              activityType: "cycling",
            },
            {
              type: "strength",
              date: "2026-03-14",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "strength",
            },
          ],
          muscleGroupFreshness: [
            { muscleGroup: "chest", lastWorkedDate: "2026-03-15", setsThisWeek: 4 },
            { muscleGroup: "shoulders", lastWorkedDate: "2026-03-15", setsThisWeek: 3 },
            { muscleGroup: "triceps", lastWorkedDate: "2026-03-15", setsThisWeek: 3 },
            { muscleGroup: "core", lastWorkedDate: "2026-03-15", setsThisWeek: 2 },
          ],
        }),
      );
      expect(result.strengthDetail?.muscleGroups).toContain("core");
    });
  });

  describe("cardio intensity selection", () => {
    it("recommends easy cardio when HIIT cap is reached", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "strength",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: ["chest"],
              activityType: "strength",
            },
            {
              type: "cardio",
              date: "2026-03-17",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
            {
              type: "cardio",
              date: "2026-03-15",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "running",
            },
            {
              type: "cardio",
              date: "2026-03-13",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
        }),
      );
      expect(result.type).toBe("cardio_easy");
      expect(result.reasoning.some((r) => r.includes("3 hard cardio"))).toBe(true);
    });

    it("recommends intervals when zone distribution skews too easy", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 80,
          trainingStressBalance: 5,
          recentActivities: [
            {
              type: "strength",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: ["chest"],
              activityType: "strength",
            },
          ],
          zoneDistribution: {
            zone1Samples: 900,
            zone2Samples: 80,
            zone3Samples: 10,
            zone4Samples: 5,
            zone5Samples: 5,
          },
        }),
      );
      expect(result.type).toBe("cardio_intervals");
      expect(result.cardioIntervalsDetail).not.toBeNull();
      expect(result.cardioIntervalsDetail?.protocol.name).toBeDefined();
    });

    it("recommends easy cardio after yesterday's hard session even with room for HIIT", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 60,
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
        }),
      );
      expect(result.type).toBe("cardio_easy");
    });

    it("enforces 48h spacing between HIIT sessions", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 85,
          recentActivities: [
            // Strength yesterday so we should do cardio today
            {
              type: "strength",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: ["chest"],
              activityType: "strength",
            },
            // Hard cardio yesterday too
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
        }),
      );
      // Even with great readiness, should be easy due to HIIT spacing
      expect(result.type).toBe("cardio_easy");
      expect(result.reasoning.some((r) => r.includes("48 hours"))).toBe(true);
    });

    it("includes HR target range when user profile is available", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 60,
          userMaxHr: 190,
          userRestingHr: 55,
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
        }),
      );
      expect(result.cardioEasyDetail?.targetHrRange).not.toBeNull();
      // Zone 2: 60-70% HRR = 55 + 135*0.6 to 55 + 135*0.7 = 136-150
      expect(result.cardioEasyDetail?.targetHrRange?.min).toBe(136);
      expect(result.cardioEasyDetail?.targetHrRange?.max).toBe(150);
    });

    it("omits HR range when user profile is incomplete", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 60,
          userMaxHr: null,
          userRestingHr: null,
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "cycling",
            },
          ],
        }),
      );
      expect(result.cardioEasyDetail?.targetHrRange).toBeNull();
    });
  });

  describe("interval protocol selection", () => {
    it("selects Norwegian 4x4 when TSB is positive (fresh)", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 85,
          trainingStressBalance: 10,
          recentActivities: [
            {
              type: "strength",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: ["chest"],
              activityType: "strength",
            },
          ],
          zoneDistribution: {
            zone1Samples: 800,
            zone2Samples: 100,
            zone3Samples: 50,
            zone4Samples: 30,
            zone5Samples: 20,
          },
        }),
      );
      expect(result.type).toBe("cardio_intervals");
      expect(result.cardioIntervalsDetail?.protocol.name).toBe("Norwegian 4x4");
    });

    it("selects 30/30 when high-intensity ratio is very low", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: 80,
          trainingStressBalance: 0,
          recentActivities: [
            {
              type: "strength",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: ["chest"],
              activityType: "strength",
            },
          ],
          zoneDistribution: {
            zone1Samples: 950,
            zone2Samples: 40,
            zone3Samples: 5,
            zone4Samples: 3,
            zone5Samples: 2,
          },
        }),
      );
      expect(result.type).toBe("cardio_intervals");
      expect(result.cardioIntervalsDetail?.protocol.name).toBe("30/30 Intervals");
    });
  });

  describe("no data scenarios", () => {
    it("provides a reasonable recommendation with no history", () => {
      const result = recommendNextWorkout(makeInput());
      // With no activities and good readiness, should suggest something
      expect(["cardio_easy", "cardio_intervals"]).toContain(result.type);
    });

    it("works with null readiness and null workload ratio", () => {
      const result = recommendNextWorkout(
        makeInput({
          readinessScore: null,
          workloadRatio: null,
          trainingStressBalance: null,
        }),
      );
      expect(result.type).not.toBe("rest");
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });

  describe("strength detail", () => {
    it("includes estimated duration based on muscle group count", () => {
      const result = recommendNextWorkout(
        makeInput({
          recentActivities: [
            {
              type: "cardio",
              date: "2026-03-18",
              wasHardDay: false,
              muscleGroups: [],
              activityType: "cycling",
            },
            {
              type: "strength",
              date: "2026-03-14",
              wasHardDay: true,
              muscleGroups: [],
              activityType: "strength",
            },
          ],
          muscleGroupFreshness: [
            { muscleGroup: "chest", lastWorkedDate: "2026-03-15", setsThisWeek: 4 },
            { muscleGroup: "shoulders", lastWorkedDate: "2026-03-15", setsThisWeek: 3 },
          ],
        }),
      );
      expect(result.type).toBe("strength");
      expect(result.strengthDetail?.estimatedDurationMinutes).toBeGreaterThan(0);
    });
  });
});

describe("muscleGroupLabel", () => {
  it("maps known muscle groups to readable labels", () => {
    expect(muscleGroupLabel("quadriceps")).toBe("Quads");
    expect(muscleGroupLabel("hamstrings")).toBe("Hamstrings");
    expect(muscleGroupLabel("lats")).toBe("Lats");
  });

  it("capitalizes unknown groups", () => {
    expect(muscleGroupLabel("deltoids")).toBe("Deltoids");
  });
});
