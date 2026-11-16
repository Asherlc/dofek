// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StrengthExerciseDetail } from "../../../../../server/src/routers/activity.ts";
import { StrengthExerciseBreakdown } from "./StrengthExerciseBreakdown.tsx";

vi.mock("react-body-highlighter", () => ({
  default: ({ type }: { type: string }) => <div data-testid={`muscle-map-${type}`} />,
  MuscleType: {
    BACK_DELTOIDS: "back_deltoids",
    CHEST: "chest",
    FRONT_DELTOIDS: "front_deltoids",
  },
}));

const exercises: StrengthExerciseDetail[] = [
  {
    activityId: "workout-1",
    exerciseIndex: 0,
    exerciseName: "Bench Press",
    exerciseType: "strength",
    equipment: "BARBELL",
    muscleGroups: ["chest"],
    sets: [
      {
        setIndex: 0,
        setType: "working",
        weightKg: 80,
        reps: 5,
        durationSeconds: 45,
        rpe: 8,
        notes: null,
      },
    ],
  },
];

it("renders recorded exercise values and units", async () => {
  render(<StrengthExerciseBreakdown exercises={exercises} units={new UnitConverter("metric")} />);
  await waitFor(() => expect(screen.getByTestId("muscle-map-anterior")).toBeVisible());
  expect(screen.getByTestId("muscle-map-posterior")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Bench Press" })).toBeVisible();
  expect(screen.getByText("barbell")).toBeVisible();
  expect(screen.getByText("Weight (kg)")).toBeVisible();
  expect(screen.getByText("80.0")).toBeVisible();
  expect(screen.getByText("5")).toBeVisible();
  expect(screen.getByText("45s")).toBeVisible();
  expect(screen.getByText("Perceived Exertion (RPE)")).toBeVisible();
  expect(screen.getByText("8")).toBeVisible();
});
