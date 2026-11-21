import { describe, expect, it } from "vitest";
import { projectWorkoutSteps } from "./planned-workout-repository.ts";

describe("projectWorkoutSteps", () => {
  it("bounds deep nesting and never emits raw vendor JSON", () => {
    let nested: Record<string, unknown> = { reps: 1, steps: [{ mystery: "secret" }] };
    for (let i = 0; i < 30; i++) nested = { reps: 1, steps: [nested] };

    const steps = projectWorkoutSteps({ steps: [nested] });

    expect(JSON.stringify(steps)).not.toContain("secret");
    expect(steps.length).toBeLessThanOrEqual(2);
  });

  it("bounds a wide document to one overflow marker without leaking source fields", () => {
    const steps = projectWorkoutSteps({
      steps: Array.from({ length: 600 }, (_, index) => ({ mystery: `secret-${index}` })),
    });

    expect(steps).toHaveLength(501);
    expect(JSON.stringify(steps)).not.toContain("secret");
  });
});
