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
      micronutrientAdequacyV2: {
        useQuery: () => ({
          data: {
            nutrients: [
              {
                nutrientId: "iron",
                nutrient: "Iron",
                unit: "mg",
                intake: {
                  totalDailyAverage: 12,
                  foodDailyAverage: 12,
                  supplementDailyAverage: 0,
                  daysTracked: 7,
                },
                adequacy: {
                  status: "below_daily_value",
                  percentDailyValue: 67,
                  message:
                    "Average intake over recorded days is below the FDA Daily Value. This generic label reference is not a personalized deficiency assessment.",
                  reference: { amount: 18 },
                },
                upperLimit: {
                  status: "not_in_ruleset",
                  message: "No upper-limit rule is included in this bounded ruleset.",
                },
                safetyStatus: "no_upper_limit_in_ruleset",
              },
            ],
          },
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
      screen.getByText(
        "Average over recorded days vs. FDA Daily Value; not a personalized deficiency or safety assessment",
      ),
    ).toBeTruthy();
  });
});
