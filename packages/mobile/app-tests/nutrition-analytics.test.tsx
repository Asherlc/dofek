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
  refetch: CallableVitestMock;
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

const adaptiveEvidence = {
  selectedWindowDays: 90,
  fitWindowDays: 28,
  minimumCalorieDays: 20,
  observedDays: 90,
  calorieDays: 82,
  weightDays: 45,
  acceptedWindows: 30,
  excludedDays: {
    missingCalories: 6,
    sourceConflict: 2,
    lowerPrioritySources: 3,
  },
} as const;

function queryResult(refetch: CallableVitestMock, overrides: Partial<MockQuery> = {}): MockQuery {
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

vi.mock("../lib/units", () => ({
  useUnitConverter: () => ({ caloriesPerDayLabel: "energy-rate-unit" }),
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
          status: "unavailable",
          estimatedTdee: null,
          estimateRange: null,
          unavailableReason: "No body-weight measurements are available in the selected period.",
          evidence: {
            ...adaptiveEvidence,
            weightDays: 0,
            acceptedWindows: 0,
          },
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
                providerDailyTotalAverage: 0,
                supplementDailyAverage: 0,
                daysTracked: 7,
              },
              sourceBreakdown: [
                {
                  providerId: "manual",
                  sourceLabel: "Manual",
                  intakeType: "itemized_food",
                  dailyAverageContribution: 12,
                  daysTracked: 7,
                },
              ],
              adequacy: {
                status: "below_daily_value",
                percentDailyValue: 67,
                message:
                  "Average intake over recorded days is below the FDA Daily Value. This generic label reference is not a personalized deficiency assessment.",
                reference: {
                  type: "daily_value",
                  amount: 18,
                  unit: "mg",
                  population: "Adults and children age 4+",
                  source: {
                    agency: "FDA",
                    title: "Daily Value",
                    url: "https://www.fda.gov/",
                    reviewedOn: "2026-07-27",
                  },
                },
              },
              upperLimit: {
                status: "not_in_ruleset",
                message: "No upper-limit rule is included in this bounded ruleset.",
              },
              safetyStatus: "no_upper_limit_in_ruleset",
            },
          ],
          dataQuality: {
            selectedWindowDays: 90,
            daysWithData: 30,
            usableDays: 28,
            overlapDays: 3,
            conflictDays: 2,
            completenessPercent: 31.1,
            sourceLabels: ["Cronometer", "Manual"],
            contributingSourceLabels: ["Manual"],
            excludedSourceLabels: ["Cronometer"],
          },
        },
      }),
    );
  });

  it("expands health acronyms in titles, guidance, and empty states", async () => {
    const { default: NutritionAnalyticsScreen } = await import("../app/nutrition-analytics");

    render(<NutritionAnalyticsScreen />);

    expect(
      screen.getByText("Adaptive Total Daily Energy Expenditure (TDEE) Estimate"),
    ).toBeTruthy();
    expect(
      screen.getByText("No body-weight measurements are available in the selected period."),
    ).toBeTruthy();
    expect(screen.getByText("28-day fit · at least 20 usable calorie days")).toBeTruthy();
    expect(
      screen.getByText(
        "Average over recorded days vs. U.S. Food and Drug Administration (FDA) Daily Value; not a personalized deficiency or safety assessment",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Nutrition data quality")).toBeTruthy();
    expect(
      screen.getByText("28 of 90 selected days are usable (31.1% completeness)."),
    ).toBeTruthy();
    expect(screen.getByText("Itemized food: 12 mg/day")).toBeTruthy();
    expect(screen.getByText("Manual · Itemized food · 12 mg/day · 7 days")).toBeTruthy();
  });

  it("shows target and upper-limit context separately with source and averaging context", async () => {
    mocks.micronutrients.mockReturnValue(
      queryResult(mocks.micronutrientsRefetch, {
        data: {
          nutrients: [
            {
              nutrientId: "vitamin_d",
              nutrient: "Vitamin D",
              unit: "mcg",
              intake: {
                totalDailyAverage: 120,
                foodDailyAverage: 20,
                providerDailyTotalAverage: 0,
                supplementDailyAverage: 100,
                daysTracked: 10,
              },
              sourceBreakdown: [],
              adequacy: {
                status: "at_or_above_daily_value",
                percentDailyValue: 600,
                message: "Target guidance from the server.",
                reference: {
                  type: "daily_value",
                  amount: 20,
                  unit: "mcg",
                  population: "Adults and children age 4+",
                  source: {
                    agency: "FDA",
                    title: "Daily Value on the Nutrition and Supplement Facts Labels",
                    url: "https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels",
                    reviewedOn: "2026-07-27",
                  },
                },
              },
              upperLimit: {
                status: "at_or_above_limit",
                amount: 100,
                unit: "mcg",
                intakeScope: "total",
                population: "U.S. adults age 19+",
                nutrientForm: "all tracked forms",
                intakeAmount: 120,
                source: {
                  agency: "NIH ODS",
                  title: "Vitamin D - Health Professional Fact Sheet",
                  url: "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
                  reviewedOn: "2026-07-27",
                },
                message: "Review this intake with a doctor or pharmacist.",
              },
              safetyStatus: "at_or_above_upper_limit",
            },
            {
              nutrientId: "vitamin_a",
              nutrient: "Vitamin A",
              unit: "mcg",
              intake: {
                totalDailyAverage: 3_500,
                foodDailyAverage: 3_000,
                providerDailyTotalAverage: 0,
                supplementDailyAverage: 500,
                daysTracked: 8,
              },
              sourceBreakdown: [],
              adequacy: null,
              upperLimit: {
                status: "not_evaluable",
                amount: 3_000,
                unit: "mcg",
                intakeScope: "total",
                population: "U.S. adults age 19+",
                nutrientForm: "preformed vitamin A",
                limitation:
                  "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
                source: {
                  agency: "NIH ODS",
                  title: "Vitamin A and Carotenoids - Health Professional Fact Sheet",
                  url: "https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/",
                  reviewedOn: "2026-07-27",
                },
                message:
                  "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
              },
              safetyStatus: "upper_limit_not_evaluable",
            },
            {
              nutrientId: "vitamin_k",
              nutrient: "Vitamin K",
              unit: "mg",
              intake: {
                totalDailyAverage: 0.1,
                foodDailyAverage: 0.1,
                providerDailyTotalAverage: 0,
                supplementDailyAverage: 0,
                daysTracked: 5,
              },
              sourceBreakdown: [],
              adequacy: {
                status: "not_evaluable",
                limitation: "Tracked unit mg does not match the FDA Daily Value unit mcg.",
                message: "Tracked unit mg does not match the FDA Daily Value unit mcg.",
                reference: {
                  type: "daily_value",
                  amount: 120,
                  unit: "mcg",
                  population: "Adults and children age 4+",
                  source: {
                    agency: "FDA",
                    title: "Daily Value",
                    url: "https://www.fda.gov/",
                    reviewedOn: "2026-07-27",
                  },
                },
              },
              upperLimit: {
                status: "not_in_ruleset",
                limitation: "No upper-limit rule is included in this bounded ruleset.",
                message: "No upper-limit rule is included in this bounded ruleset.",
              },
              safetyStatus: "no_upper_limit_in_ruleset",
            },
          ],
          dataQuality: {
            selectedWindowDays: 30,
            daysWithData: 30,
            usableDays: 30,
            overlapDays: 0,
            conflictDays: 0,
            completenessPercent: 100,
            sourceLabels: ["Manual"],
            contributingSourceLabels: ["Manual"],
            excludedSourceLabels: [],
          },
        },
      }),
    );
    const { default: NutritionAnalyticsScreen } = await import("../app/nutrition-analytics");

    render(<NutritionAnalyticsScreen />);

    expect(
      screen.getByText(
        "Target: 600% of U.S. Food and Drug Administration (FDA) Daily Value (20 mcg/day)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Tolerable Upper Intake Level (UL): 100 mcg/day for total daily intake"),
    ).toBeTruthy();
    expect(
      screen.getByText("UL status: At or above the Tolerable Upper Intake Level (UL)"),
    ).toBeTruthy();
    expect(screen.getByText("UL source: Vitamin D - Health Professional Fact Sheet")).toBeTruthy();
    expect(
      screen.getByText("Average over 10 recorded days in a 30-day selected window."),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Vitamin D. Target: 600% of U.S. Food and Drug Administration (FDA) Daily Value (20 mcg/day). Target status: Meets or exceeds target. Target source: Daily Value on the Nutrition and Supplement Facts Labels. Target guidance: Target guidance from the server. Tolerable Upper Intake Level (UL): 100 mcg/day for total daily intake. UL status: At or above the Tolerable Upper Intake Level (UL). UL source: Vitamin D - Health Professional Fact Sheet. UL guidance: Review this intake with a doctor or pharmacist. Average over 10 recorded days in a 30-day selected window.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Vitamin A")).toBeTruthy();
    expect(
      screen.getByText(
        "Target: No U.S. Food and Drug Administration (FDA) Daily Value target is available for this nutrient.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Tolerable Upper Intake Level (UL) not evaluable")).toBeTruthy();
    expect(screen.getByText("Vitamin K")).toBeTruthy();
    expect(
      screen.getByText(
        "Target: U.S. Food and Drug Administration (FDA) Daily Value target not evaluable",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Target guidance: Tracked unit mg does not match the FDA Daily Value unit mcg\./,
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
    const { default: NutritionAnalyticsScreen } = await import("../app/nutrition-analytics");

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
          status: "available",
          estimatedTdee: 2_250,
          estimateRange: { minimum: 2_180, maximum: 2_320 },
          unavailableReason: null,
          evidence: adaptiveEvidence,
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
                providerDailyTotalAverage: 0,
                supplementDailyAverage: 0,
                daysTracked: 7,
              },
              sourceBreakdown: [
                {
                  providerId: "manual",
                  sourceLabel: "Manual",
                  intakeType: "itemized_food",
                  dailyAverageContribution: 12,
                  daysTracked: 7,
                },
              ],
              adequacy: {
                status: "below_daily_value",
                percentDailyValue: 67,
                message: "Below Daily Value.",
                reference: {
                  type: "daily_value",
                  amount: 18,
                  unit: "mg",
                  population: "Adults and children age 4+",
                  source: {
                    agency: "FDA",
                    title: "Daily Value",
                    url: "https://www.fda.gov/",
                    reviewedOn: "2026-07-27",
                  },
                },
              },
              upperLimit: {
                status: "not_in_ruleset",
                message: "No upper-limit rule.",
              },
              safetyStatus: "no_upper_limit_in_ruleset",
            },
          ],
          dataQuality: {
            selectedWindowDays: 90,
            daysWithData: 30,
            usableDays: 28,
            overlapDays: 3,
            conflictDays: 2,
            completenessPercent: 31.1,
            sourceLabels: ["Cronometer", "Manual"],
            contributingSourceLabels: ["Manual"],
            excludedSourceLabels: ["Cronometer"],
          },
        },
        error: new Error("Micronutrient refresh failed."),
        isError: true,
        isFetching: true,
        isSuccess: false,
      }),
    );
    const { default: NutritionAnalyticsScreen } = await import("../app/nutrition-analytics");

    render(<NutritionAnalyticsScreen />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Nutrition analytics refresh failed.")).toBeTruthy();
    expect(screen.getByText("Observed rolling range: 2,180–2,320 energy-rate-unit")).toBeTruthy();
    expect(screen.getByText("90-day evaluation · 90 accessible calendar days")).toBeTruthy();
    expect(screen.getByText("82 calorie days · 45 weight days · 30 accepted windows")).toBeTruthy();
    expect(
      screen.getByText(
        "Excluded: 6 missing calorie days · 2 source-conflict days · 3 days with lower-priority sources",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Iron")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Retrying..." }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
});
