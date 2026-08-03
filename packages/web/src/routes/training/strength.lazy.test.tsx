/** @vitest-environment jsdom */

import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expectRegistryInputs,
  renderRoute,
  resetRangePlumbingState,
  state,
} from "./range-plumbing.test-helper.tsx";

describe("strength route range plumbing", () => {
  beforeEach(resetRangePlumbingState);
  afterEach(cleanup);

  it("passes finite and All ranges to selected-range chart queries", async () => {
    state.days = 30;
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expectRegistryInputs("strength", 30);
    expect(screen.getByText("Strength Workouts")).toBeTruthy();
    expect(
      screen.getByText(
        "Selected 30-day range · Strength, strength training, functional strength, and functional fitness",
      ),
    ).toBeTruthy();
    expect(state.recentActivitiesProps).toContainEqual({
      activityTypes: ["strength", "strength_training", "functional_strength", "functional_fitness"],
      emptyMessage:
        "No strength workouts in the selected 30-day range. Included types: strength, strength training, functional strength, and functional fitness.",
    });

    cleanup();
    state.queryCalls.length = 0;
    state.recentActivitiesProps.length = 0;
    state.days = null;
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expectRegistryInputs("strength", null);
    expect(
      screen.getByText(
        "All recorded time · Strength, strength training, functional strength, and functional fitness",
      ),
    ).toBeTruthy();
    expect(state.recentActivitiesProps).toContainEqual({
      activityTypes: ["strength", "strength_training", "functional_strength", "functional_fitness"],
      emptyMessage:
        "No strength workouts across all recorded time. Included types: strength, strength training, functional strength, and functional fitness.",
    });
  });
});
