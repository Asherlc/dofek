// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const loggerInfoMock = vi.fn();
const openExternalUrlMock = vi.fn(() => Promise.resolve(true));
const invalidateFoodByDateMock = vi.fn(() => Promise.resolve());
const mockUseRefresh = vi.fn(() => ({ refreshing: false, onRefresh: vi.fn() }));
let foodByDateQuery: {
  data: unknown;
  error?: Error;
  isError: boolean;
  isFetching?: boolean;
  isLoading: boolean;
};

vi.mock("expo-router", () => ({ useRouter: () => ({ push: mockRouterPush }) }));
vi.mock("../../lib/open-external-url", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));
vi.mock("../../lib/telemetry", () => ({ logger: { info: loggerInfoMock } }));
vi.mock("../../lib/trpc", () => ({
  trpc: {
    food: { byDateV2: { useQuery: () => foodByDateQuery } },
    useUtils: () => ({ food: { byDateV2: { invalidate: invalidateFoodByDateMock } } }),
  },
}));
vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (...args: unknown[]) => mockUseRefresh(...args),
}));

describe("FoodScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    foodByDateQuery = {
      data: {
        entries: [],
        resolution: {
          status: "available",
          message: "Totals use the only available nutrition source.",
          sourceProviders: ["dofek"],
          contributingProviders: ["dofek"],
          excludedProviders: [],
          sourceLabels: ["Dofek"],
          contributingSourceLabels: ["Dofek"],
          excludedSourceLabels: [],
          contributionGrain: "itemized",
          contributionLabel: "Dofek itemized entries",
        },
        intakeContext: null,
        summary: {
          calories: 120,
          mealCalories: { breakfast: 120, lunch: 0, dinner: 0, snack: 0, other: 0 },
          calorieGoal: { target: 2000, remaining: 1880, over: 0, progressPercentage: 6 },
          macros: {
            protein: { grams: 18, calories: 72, energySharePercentage: 72 },
            carbs: { grams: 7, calories: 28, energySharePercentage: 28 },
            fat: { grams: 0, calories: 0, energySharePercentage: 0 },
          },
        },
      },
      isError: false,
      isLoading: false,
    };
  });

  it("scopes pull-to-refresh to the selected-date food DTO", async () => {
    const { default: FoodScreen } = await import("../../app/(tabs)/food");
    render(<FoodScreen />);
    await mockUseRefresh.mock.calls.at(-1)?.[0]?.invalidate?.();
    expect(invalidateFoodByDateMock).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("records a screen breadcrumb when the nutrition tab renders", async () => {
    const { default: FoodScreen } = await import("../../app/(tabs)/food");
    render(<FoodScreen />);
    expect(loggerInfoMock).toHaveBeenCalledWith("screen-navigation", "Nutrition tab rendered", {
      route: "food",
    });
  });

  it("keeps existing food entries visible during a background refetch", async () => {
    foodByDateQuery = {
      ...foodByDateQuery,
      data: {
        ...(typeof foodByDateQuery.data === "object" && foodByDateQuery.data !== null
          ? foodByDateQuery.data
          : {}),
        entries: [
          {
            id: "food-1",
            food_name: "Greek yogurt",
            meal: "breakfast",
            calories: 120,
            protein_g: 18,
            carbs_g: 7,
            fat_g: 0,
            food_description: "Plain yogurt",
          },
        ],
      },
      isFetching: true,
      isLoading: true,
    };
    const { default: FoodScreen } = await import("../../app/(tabs)/food");
    render(<FoodScreen />);
    expect(screen.getByText("Greek yogurt")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("opens the read-only nutrition attribution link", async () => {
    const { default: FoodScreen } = await import("../../app/(tabs)/food");
    render(<FoodScreen />);
    fireEvent.click(
      screen.getByRole("link", { name: "Powered by fatsecret nutrition API (www.fatsecret.com)" }),
    );
    expect(openExternalUrlMock).toHaveBeenCalledWith("https://www.fatsecret.com/", "food");
  });
});
