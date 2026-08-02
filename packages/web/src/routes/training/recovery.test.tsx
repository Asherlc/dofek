/** @vitest-environment jsdom */

import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expectRegistryInputs,
  renderRoute,
  resetRangePlumbingState,
  state,
} from "./range-plumbing.test-helper.tsx";

describe("recovery route range plumbing", () => {
  beforeEach(resetRangePlumbingState);
  afterEach(cleanup);

  it("passes finite and All ranges to selected-range chart queries", async () => {
    state.days = 30;
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", 30);
    expect(
      screen.getByText(
        "Composite score from heart rate variability, resting heart rate, sleep, and load balance",
      ),
    ).toBeTruthy();
    const decisionSummary = screen.getByRole("region", { name: "What matters today" });
    const readinessSection = screen.getByText("Readiness Score");
    expect(
      decisionSummary.compareDocumentPosition(readinessSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Server-authored recovery action")).toBeTruthy();
    expect(screen.getByText("Heart Rate Variability Coefficient of Variation")).toBeTruthy();
    expect(screen.getByText("7-day rolling heart rate variability")).toBeTruthy();

    cleanup();
    state.queryCalls.length = 0;
    state.days = null;
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", null);
  });
});
