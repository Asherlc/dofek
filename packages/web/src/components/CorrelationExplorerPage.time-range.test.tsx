/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  clearQueryCalls,
  expectCallsContaining,
  expectRegistryCovered,
} from "./test-helpers/TimeRangeSelectorConsumers.tsx";

describe("CorrelationExplorerPage time range", () => {
  beforeEach(clearQueryCalls);
  afterEach(cleanup);

  it("passes finite and All ranges to selected query inputs", async () => {
    const { CorrelationExplorerPage } = await import("../pages/CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expectCallsContaining([
      {
        name: "correlation.computeV2",
        input: { metricX: "protein", metricY: "hrv", days: 7, lag: 0 },
      },
      {
        name: "correlation.observations",
        input: {
          metricX: "protein",
          metricY: "hrv",
          days: 7,
          lag: 0,
          pageSize: 25,
        },
      },
    ]);
    expectRegistryCovered("correlation");

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expectCallsContaining([
      {
        name: "correlation.computeV2",
        input: { metricX: "protein", metricY: "hrv", days: null, lag: 0 },
      },
      {
        name: "correlation.observations",
        input: {
          metricX: "protein",
          metricY: "hrv",
          days: null,
          lag: 0,
          pageSize: 25,
        },
      },
    ]);
    expectRegistryCovered("correlation");
  });
});
