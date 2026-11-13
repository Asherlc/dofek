/** @vitest-environment jsdom */

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";
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
});
