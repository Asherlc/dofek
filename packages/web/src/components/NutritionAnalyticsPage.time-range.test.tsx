/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearQueryCalls,
  expectCallsContaining,
  expectRegistryCovered,
} from "./test-helpers/TimeRangeSelectorConsumers.tsx";

describe("NutritionAnalyticsPage time range", () => {
  beforeEach(clearQueryCalls);
  afterEach(cleanup);

  it("passes finite and All ranges to selected chart queries", async () => {
    const { NutritionAnalyticsPage } = await import("../pages/NutritionAnalyticsPage.tsx");
    render(<NutritionAnalyticsPage />);
    expect(screen.getByText("Adaptive Total Daily Energy Expenditure (TDEE)")).toBeTruthy();

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expectCallsContaining([
      { name: "nutritionAnalytics.micronutrientAdequacyV2", input: { days: 7 } },
      { name: "nutritionAnalytics.macroRatios", input: { days: 7 } },
      { name: "nutritionAnalytics.adaptiveTdee", input: { days: 90 } },
    ]);
    expectRegistryCovered("nutritionAnalytics");

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expectCallsContaining([
      { name: "nutritionAnalytics.micronutrientAdequacyV2", input: { days: null } },
      { name: "nutritionAnalytics.macroRatios", input: { days: null } },
      { name: "nutritionAnalytics.adaptiveTdee", input: { days: null } },
    ]);
    expectRegistryCovered("nutritionAnalytics");
    expect(
      screen.getByText(/U\.S\. Food and Drug Administration \(FDA\) Daily Value \(All\)/),
    ).toBeTruthy();
    expect(screen.queryByText(/null days/)).toBeNull();
  });
});
