/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  BodyHarness,
  clearQueryCalls,
  expectCallsContaining,
  expectRegistryCovered,
} from "./test-helpers/TimeRangeSelectorConsumers.tsx";

describe("BodyPage time range", () => {
  beforeEach(clearQueryCalls);
  afterEach(cleanup);

  it("passes finite and All ranges to selected chart queries", async () => {
    const { BodyPage } = await import("../pages/BodyPage.tsx");
    render(<BodyHarness BodyPage={BodyPage} />);

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expectCallsContaining([
      { name: "dailyMetrics.trends", input: { days: 7, endDate: "2026-07-08" } },
      { name: "dailyMetrics.list", input: { days: 7, endDate: "2026-07-08" } },
      { name: "dailyMetrics.hrvBaseline", input: { days: 7, endDate: "2026-07-08" } },
      { name: "stress.scores", input: { days: 7, endDate: "2026-07-08" } },
      { name: "bodyAnalytics.weightOverview", input: { days: 7, endDate: "2026-07-08" } },
      { name: "insights.compute", input: { days: 90, endDate: "2026-07-08" } },
    ]);
    expectRegistryCovered("body");

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expectCallsContaining([
      { name: "dailyMetrics.trends", input: { days: null, endDate: "2026-07-08" } },
      { name: "dailyMetrics.list", input: { days: null, endDate: "2026-07-08" } },
      { name: "dailyMetrics.hrvBaseline", input: { days: null, endDate: "2026-07-08" } },
      { name: "stress.scores", input: { days: null, endDate: "2026-07-08" } },
      { name: "bodyAnalytics.weightOverview", input: { days: null, endDate: "2026-07-08" } },
      { name: "insights.compute", input: { days: null, endDate: "2026-07-08" } },
    ]);
    expectRegistryCovered("body");
  });
});
