/** @vitest-environment jsdom */

import { keepPreviousData } from "@tanstack/react-query";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
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

    cleanup();
    state.queryCalls.length = 0;
    state.days = null;
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expectRegistryInputs("strength", null);
  });

  it("loads training progression rows for the Strength evidence card", async () => {
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expect(state.queryCalls).toContainEqual(
      expect.objectContaining({ name: "trainingProgression.strength" }),
    );
  });

  it("shows a strength progression refresh error while keeping cached rows visible", async () => {
    state.trainingProgressionStrengthQuery = {
      data: [1],
      isLoading: false,
      error: new Error("Could not refresh strength progression"),
    };
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expect(screen.getByText("Could not refresh strength progression")).toBeTruthy();
    expect(screen.getByTestId("progression-rows-count").textContent).toBe("1");
  });

  it("shows a compact loading panel while strength progression loads without a cache", async () => {
    state.trainingProgressionStrengthQuery = { data: undefined, isLoading: true, error: null };
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.getByTestId("progression-rows-count").textContent).toBe("0");
  });

  it("keeps cached progression rows visible while a refresh is loading", async () => {
    state.trainingProgressionStrengthQuery = { data: [1], isLoading: true, error: null };
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    expect(screen.getByTestId("progression-rows-count").textContent).toBe("1");
  });

  it("keeps previous logged-set data across selected ranges with slow query options", async () => {
    resetRangePlumbingState();
    state.days = 30;
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expect(
      state.queryCalls.find((call) => call.name === "strength.loggedSetComparison")?.options,
    ).toEqual({ ...TRAINING_SLOW_QUERY_OPTIONS, placeholderData: keepPreviousData });
  });
});
