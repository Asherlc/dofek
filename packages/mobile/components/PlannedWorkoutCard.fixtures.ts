import type { AppRouterOutputs } from "dofek-server/router";

type PlannedWorkoutDay = AppRouterOutputs["calendar"]["upcomingWorkouts"][number];
type PlannedWorkout = PlannedWorkoutDay["workouts"][number];

/** Representative planned workout shared by card tests and stories. */
export const samplePlannedWorkout: PlannedWorkout = {
  id: "event-1",
  providerId: "intervals.icu",
  title: "Threshold intervals",
  description: "Hold the target power.",
  sportType: "cycling",
  startTime: "07:30",
  steps: [
    {
      kind: "repeat",
      repetitions: 3,
      text: "Main set",
      steps: [
        {
          kind: "step",
          text: "Interval",
          durationSeconds: 480,
          distanceMeters: null,
          targets: [{ type: "power", value: null, start: 200, end: 240, unit: "W" }],
        },
        {
          kind: "step",
          text: "Recovery",
          durationSeconds: 240,
          distanceMeters: null,
          targets: [{ type: "heart_rate", value: 65, start: null, end: null, unit: "%" }],
        },
      ],
    },
    {
      kind: "step",
      text: null,
      durationSeconds: null,
      distanceMeters: 5000,
      targets: [{ type: "pace", value: null, start: 300, end: 330, unit: "s/km" }],
    },
  ],
};

/** Representative server-projected upcoming workouts shared by tests and stories. */
export const plannedWorkoutDays = [
  {
    date: "2026-03-18",
    workouts: [samplePlannedWorkout],
  },
] satisfies readonly PlannedWorkoutDay[];
