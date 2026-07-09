/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  expectRegistryInputs,
  resetRangePlumbingState,
  state,
} from "../routes/training/range-plumbing.test-helper.tsx";
import { TrainingInsightsPanel } from "./TrainingInsightsPanel.tsx";

describe("TrainingInsightsPanel range plumbing", () => {
  beforeEach(resetRangePlumbingState);
  afterEach(cleanup);

  it("passes finite and All ranges to selected-range chart queries", () => {
    render(<TrainingInsightsPanel days={30} />);
    expectRegistryInputs("trainingInsightsPanel", 30);

    cleanup();
    state.queryCalls.length = 0;
    render(<TrainingInsightsPanel days={null} />);
    expectRegistryInputs("trainingInsightsPanel", null);
  });
});
