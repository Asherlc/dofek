/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  clearQueryCalls,
  expectCallsContaining,
  expectRegistryCovered,
} from "./test-helpers/TimeRangeSelectorConsumers.tsx";

describe("SleepPage time range", () => {
  beforeEach(clearQueryCalls);
  afterEach(cleanup);

  it("passes finite and All ranges to selected chart queries while preserving support minima", async () => {
    const { SleepPage } = await import("../pages/SleepPage.tsx");
    render(<SleepPage />);

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expectCallsContaining([
      { name: "sleep.list", input: { days: 7, endDate: "2026-07-08" } },
      { name: "insights.compute", input: { days: 90, endDate: "2026-07-08" } },
    ]);
    expectRegistryCovered("sleep");

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expectCallsContaining([
      { name: "sleep.list", input: { days: null, endDate: "2026-07-08" } },
      { name: "insights.compute", input: { days: null, endDate: "2026-07-08" } },
    ]);
    expectRegistryCovered("sleep");
  });
});
