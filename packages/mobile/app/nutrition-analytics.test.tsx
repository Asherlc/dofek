/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockQuery {
  data: unknown;
  error: Error | null;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  adaptiveTdee: vi.fn<() => MockQuery>(),
  adaptiveTdeeRefetch: vi.fn(),
  macroRatios: vi.fn<() => MockQuery>(),
  macroRatiosRefetch: vi.fn(),
  micronutrients: vi.fn<() => MockQuery>(),
  micronutrientsRefetch: vi.fn(),
  routerPush: vi.fn(),
}));

function queryResult(
  refetch: ReturnType<typeof vi.fn>,
  overrides: Partial<MockQuery> = {},
): MockQuery {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isSuccess: true,
    refetch,
    ...overrides,
  };
}

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
        useQuery: mocks.adaptiveTdee,
      },
      macroRatios: {
        useQuery: mocks.macroRatios,
      },
      micronutrientAdequacyV2: {
        useQuery: mocks.micronutrients,
      },
    },
  },
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("../theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../theme")>();
  return {
    ...actual,
    colors: new Proxy(actual.colors, { get: () => "#71717a" }),
  };
});

describe("NutritionAnalyticsScreen", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.adaptiveTdeeRefetch.mockReset();
    mocks.macroRatiosRefetch.mockReset();
    mocks.micronutrientsRefetch.mockReset();
    mocks.routerPush.mockReset();
    mocks.adaptiveTdee.mockReturnValue(
      queryResult(mocks.adaptiveTdeeRefetch, {
        data: {
          estimatedTdee: null,
          confidence: 0,
          dataPoints: 0,
          dailyData: [],
        },
      }),
    );
    mocks.macroRatios.mockReturnValue(queryResult(mocks.macroRatiosRefetch, { data: [] }));
    mocks.micronutrients.mockReturnValue(
      queryResult(mocks.micronutrientsRefetch, {
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
      }),
    );
  });

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
        "Average over recorded days vs. U.S. Food and Drug Administration (FDA) Daily Value; not a personalized deficiency or safety assessment",
      ),
    ).toBeTruthy();
  });

  it("consolidates query failures into one exact root error and one recovery action", async () => {
    mocks.adaptiveTdee.mockReturnValue(
      queryResult(mocks.adaptiveTdeeRefetch, {
        error: new Error("Body measurements are unavailable."),
        isError: true,
        isSuccess: false,
      }),
    );
    mocks.macroRatios.mockReturnValue(
      queryResult(mocks.macroRatiosRefetch, {
        error: new Error("Macro analytics are unavailable."),
        isError: true,
        isSuccess: false,
      }),
    );
    mocks.micronutrients.mockReturnValue(
      queryResult(mocks.micronutrientsRefetch, {
        error: new Error("Micronutrient analytics are unavailable."),
        isError: true,
        isSuccess: false,
      }),
    );
    const { default: NutritionAnalyticsScreen } = await import("./nutrition-analytics");

    render(<NutritionAnalyticsScreen />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Body measurements are unavailable.")).toBeTruthy();
    expect(screen.queryByText("Macro analytics are unavailable.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry nutrition analytics" }));

    expect(mocks.adaptiveTdeeRefetch).toHaveBeenCalledOnce();
    expect(mocks.macroRatiosRefetch).toHaveBeenCalledOnce();
    expect(mocks.micronutrientsRefetch).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("link", { name: "Review data sources" }));
    expect(mocks.routerPush).toHaveBeenCalledWith("/providers");
  });

  it("keeps cached analytics visible behind one background-refresh error", async () => {
    mocks.adaptiveTdee.mockReturnValue(
      queryResult(mocks.adaptiveTdeeRefetch, {
        data: {
          estimatedTdee: 2_250,
          confidence: 82,
          dataPoints: 30,
          dailyData: [],
        },
        error: new Error("Nutrition analytics refresh failed."),
        isError: true,
        isSuccess: false,
      }),
    );
    mocks.macroRatios.mockReturnValue(
      queryResult(mocks.macroRatiosRefetch, {
        data: [],
        error: new Error("Macro refresh failed."),
        isError: true,
        isSuccess: false,
      }),
    );
    mocks.micronutrients.mockReturnValue(
      queryResult(mocks.micronutrientsRefetch, {
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
                message: "Below Daily Value.",
                reference: { amount: 18 },
              },
              upperLimit: {
                status: "not_in_ruleset",
                message: "No upper-limit rule.",
              },
              safetyStatus: "no_upper_limit_in_ruleset",
            },
          ],
        },
        error: new Error("Micronutrient refresh failed."),
        isError: true,
        isFetching: true,
        isSuccess: false,
      }),
    );
    const { default: NutritionAnalyticsScreen } = await import("./nutrition-analytics");

    render(<NutritionAnalyticsScreen />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Nutrition analytics refresh failed.")).toBeTruthy();
    expect(screen.getByText("Based on 30 data points")).toBeTruthy();
    expect(screen.getByText("Iron")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retrying..." }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
});
