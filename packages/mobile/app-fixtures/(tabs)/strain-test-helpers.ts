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
      displayedStrain: 16,
      displayedDate: "2026-03-28",
      timeSeries: [
        {
          date: "2026-03-28",
          acuteLoad: 27.4,
          chronicLoad: 24.9,
          workloadRatio: 1.1,
          strain: 16,
        },
      ],
    },
    strainTarget: undefined,
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
