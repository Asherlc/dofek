/** @vitest-environment jsdom */

import { keepPreviousData } from "@tanstack/react-query";
import { cleanup } from "@testing-library/react";
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

  it("keeps previous logged-set data across selected ranges with slow query options", async () => {
    resetRangePlumbingState();
    state.days = 30;
    await renderRoute("/training/strength", () => import("./strength.lazy.tsx"));
    expect(
      state.queryCalls.find((call) => call.name === "strength.loggedSetComparison")?.options,
    ).toEqual({ ...TRAINING_SLOW_QUERY_OPTIONS, placeholderData: keepPreviousData });
  });
});
