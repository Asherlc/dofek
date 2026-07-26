/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/ChartTitleWithTooltip", () => ({
  ChartTitleWithTooltip: ({ title, description }: { title: string; description: string }) => (
    <>
      <div>{title}</div>
      <div>{description}</div>
    </>
  ),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    nutritionAnalytics: {
      adaptiveTdee: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
        }),
      },
      macroRatios: {
        useQuery: () => ({
          data: [],
          isLoading: false,
        }),
      },
      micronutrientAdequacy: {
        useQuery: () => ({
          data: [
            {
              nutrient: "Iron",
              unit: "mg",
              rda: 18,
              avgIntake: 12,
              percentRda: 67,
              daysTracked: 7,
            },
          ],
          isLoading: false,
        }),
      },
    },
  },
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("../theme", () => ({
  colors: new Proxy({}, { get: () => "#71717a" }),
}));

describe("NutritionAnalyticsScreen", () => {
  it("expands health acronyms in titles, guidance, and empty states", async () => {
    const { default: NutritionAnalyticsScreen } = await import("./nutrition-analytics");

    render(<NutritionAnalyticsScreen />);

    expect(
      screen.getByText("Adaptive Total Daily Energy Expenditure (TDEE) Estimate"),
    ).toBeTruthy();
    expect(
      screen.getByText("Not enough data to estimate Total Daily Energy Expenditure (TDEE)"),
    ).toBeTruthy();
    expect(
      screen.getByText("Average daily intake vs. Recommended Dietary Allowance (RDA)"),
    ).toBeTruthy();
  });
});
