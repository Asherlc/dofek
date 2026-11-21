import type { LoggedSetComparison } from "dofek-server/types";

const set = (weightKg: number, reps = 6) => ({
  weightKg,
  reps,
  setId: "set",
  sourceProviders: ["whoop"],
});
const sessions = [3, 7, 12, 20].map((day, index) => ({
  activityId: String(day),
  date: `2026-11-${String(day).padStart(2, "0")}`,
  loggedSets: [3, 4, 2, 3][index] ?? 3,
  sourceProviders: ["whoop"],
  heaviestSets: index === 2 ? [set(70, 8)] : [set([80, 82.5, 0, 85][index] ?? 80)],
}));
export const loggedSetFixture: LoggedSetComparison = {
  exercises: [
    {
      exerciseId: "bench",
      exerciseName: "Bench press",
      equipment: "Barbell",
      totalLoggedSets: 12,
      sessions,
      comparisons: [
        {
          reps: 6,
          observedDates: 3,
          first: { ...set(80), activityId: "3", date: "2026-11-03" },
          latest: { ...set(85), activityId: "20", date: "2026-11-20" },
        },
        {
          reps: 8,
          observedDates: 1,
          first: { ...set(70, 8), activityId: "12", date: "2026-11-12" },
          latest: null,
        },
      ],
    },
    {
      exerciseId: "dumbbell",
      exerciseName: "Bench press",
      equipment: "Dumbbell",
      totalLoggedSets: 1,
      sessions: [
        {
          activityId: "dumbbell-session",
          date: "2026-11-12",
          loggedSets: 1,
          sourceProviders: ["whoop"],
          heaviestSets: [set(20)],
        },
      ],
      comparisons: [
        {
          reps: 6,
          observedDates: 1,
          first: { ...set(20), activityId: "dumbbell-session", date: "2026-11-12" },
          latest: null,
        },
      ],
    },
  ],
  research: {
    summary: "Supervised failure sets in trained men; bench-press and squat strength were tested.",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/pmid/30153194/",
  },
};
