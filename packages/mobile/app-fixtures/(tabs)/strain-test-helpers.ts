import type { TrainingSection } from "../../lib/training-sections";

export const noPolarizationWeeks = {
  model: "treff-three-zone",
  activityScope: "cycling",
  threshold: 2,
  maxHr: 190,
  explanation: "Cached mobile polarization.",
  method: {
    formula: "Cached Treff formula.",
    zoneBasis: "Cached Treff zones.",
    calculationChoice: "Cached calculation choice.",
    interpretation: "Cached descriptive interpretation.",
    source: {
      title: "Treff source",
      url: "https://doi.org/10.3389/fphys.2019.00707",
    },
  },
  weeks: [],
};

export const sectionExpectations = {
  overview: { queries: ["training", "sportVolume"], cards: ["Training Load", "Weekly Volume"] },
  endurance: {
    queries: ["hrZones", "polarization", "sportVolume"],
    cards: ["Weekly Volume", "Easy-to-hard training balance"],
  },
  cycling: {
    queries: ["training", "sportVolume"],
    cards: ["Weekly Volume", "Vertical Ascent Rate"],
  },
  running: { queries: ["running", "sportVolume"], cards: ["Running", "Weekly Volume"] },
  strength: {
    queries: ["training", "strengthVolume", "loggedSets"],
    cards: ["Strength Volume", "Sets and performance"],
  },
  hiking: { queries: ["sportVolume"], cards: ["Route comparison", "Weekly Volume"] },
  climbing: {
    queries: ["training", "strengths", "locationMap", "climbingVolume"],
    cards: ["Climbing Volume", "Climbing strengths"],
  },
  recovery: { queries: ["training"], cards: ["Training Load"] },
} satisfies Record<TrainingSection, { queries: string[]; cards: string[] }>;

export function defaultMockTrainingData(): Record<string, unknown> {
  return {
    workloadRatio: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedDate: "2026-03-28",
      timeSeries: [
        {
          date: "2026-03-28",
          acuteLoad: 27.4,
          chronicLoad: 24.9,
          workloadRatio: 1.1,
        },
      ],
    },
    activities: [],
    weeklyVolume: [],
    progressiveOverload: [],
    verticalAscent: [],
    climbing: {
      gradeProgression: null,
      volumeByGrade: [],
      sessionSummary: [],
      hangboarding: {
        sessionCount: 0,
        totalDurationSeconds: 0,
        averageDurationSeconds: null,
        totalWorkDurationSeconds: null,
        totalRestDurationSeconds: null,
        workIntervalCount: null,
        averageHeartRate: null,
        peakHeartRate: null,
        latestSession: null,
        daily: [],
      },
    },
  };
}

export function recentCyclingActivityFixture() {
  return {
    id: 42,
    name: "Morning Ride",
    canonical_type: "cycling",
    primary_canonical_type: null,
    started_at: "2026-03-28T07:00:00.000Z",
    ended_at: "2026-03-28T08:00:00.000Z",
    avg_hr: 150,
    max_hr: 178,
    avg_power: 240,
    distance_meters: 24000,
    distance_state: { status: "available" },
    calories: 640,
  };
}
