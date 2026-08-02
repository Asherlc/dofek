/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  clearQueryCalls,
  expectCallsContaining,
  expectRegistryCovered,
  getCapturedRouteComponent,
} from "./TimeRangeSelector.consumers.test-helper.tsx";

describe("Behavior impact page time range", () => {
  beforeEach(clearQueryCalls);
  afterEach(cleanup);

  it("passes finite and All ranges to selected query inputs", async () => {
    await import("../routes/behavior-impact.tsx");
    const BehaviorImpactPage = getCapturedRouteComponent("/behavior-impact");
    if (!BehaviorImpactPage) throw new Error("Behavior Impact route component was not captured");
    render(<BehaviorImpactPage />);

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expectCallsContaining([{ name: "behaviorImpact.impactSummary", input: { days: 7 } }]);
    expectRegistryCovered("behaviorImpact");

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expectCallsContaining([{ name: "behaviorImpact.impactSummary", input: { days: null } }]);
    expectRegistryCovered("behaviorImpact");
  });
});
