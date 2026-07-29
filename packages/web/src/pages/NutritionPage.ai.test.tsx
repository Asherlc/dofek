// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const foodRefetchMock = vi.fn();
const analyzeItemsMutateAsyncMock = vi.fn();
const createFoodMutateMock = vi.fn();
const createAiEntryMutateAsyncMock = vi.fn();
const deleteMutateMock = vi.fn();
let foodByDateQuery: {
  data: unknown;
  error: Error | null;
  isFetching?: boolean;
  isLoading: boolean;
};
const availableResolution = {
  status: "available",
  message: "Totals use the only available nutrition source.",
  sourceProviders: ["dofek"],
  contributingProviders: ["dofek"],
  excludedProviders: [],
  sourceLabels: ["dofek"],
  contributingSourceLabels: ["dofek"],
  excludedSourceLabels: [],
};

vi.mock("../lib/telemetry.ts", () => ({
  captureException: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    food: {
      byDateV2: {
        useQuery: () => ({ ...foodByDateQuery, refetch: foodRefetchMock }),
      },
      create: {
        useMutation: () => ({
          mutate: createFoodMutateMock,
          mutateAsync: createAiEntryMutateAsyncMock,
          isPending: false,
        }),
      },
      delete: {
        useMutation: () => ({ mutate: deleteMutateMock, isPending: false }),
      },
      analyzeItemsWithAi: {
        useMutation: () => ({ mutateAsync: analyzeItemsMutateAsyncMock, isPending: false }),
      },
      analyzeWithAi: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    useUtils: () => ({
      food: {
        search: {
          fetch: vi.fn().mockResolvedValue([]),
        },
      },
    }),
  },
}));

describe("NutritionPage AI meal confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    foodByDateQuery = {
      data: {
        entries: [],
        resolution: availableResolution,
        summary: {
          calories: 0,
          mealCalories: { breakfast: 0, lunch: 0, dinner: 0, snack: 0, other: 0 },
          calorieGoal: { target: 2000, remaining: 2000, over: 0, progressPercentage: 0 },
          macros: {
            protein: { grams: 0, calories: 0, energySharePercentage: 0 },
            carbs: { grams: 0, calories: 0, energySharePercentage: 0 },
            fat: { grams: 0, calories: 0, energySharePercentage: 0 },
          },
        },
      },
      error: null,
      isLoading: false,
    };
    analyzeItemsMutateAsyncMock.mockResolvedValue({
      items: [
        {
          meal: "breakfast",
          foodName: "Eggs",
          foodDescription: "2 large eggs",
          category: "eggs",
          calories: 140,
          proteinG: 12,
          carbsG: 1,
          fatG: 10,
          fiberG: 0,
          saturatedFatG: 3,
          sugarG: 0,
          sodiumMg: 140,
        },
      ],
    });
  });

  it("waits for confirmation before creating AI parsed food entries", async () => {
    const { NutritionPage } = await import("./NutritionPage");

    render(<NutritionPage />);

    fireEvent.change(screen.getByPlaceholderText(/two eggs/i), {
      target: { value: "two eggs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log with AI" }));

    await screen.findByText("Review AI meal");

    expect(screen.getByText("Eggs")).toBeTruthy();
    expect(createAiEntryMutateAsyncMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and log" }));

    await waitFor(() => {
      expect(createAiEntryMutateAsyncMock).toHaveBeenCalledWith({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        nutrients: {},
        meal: "breakfast",
        foodName: "Eggs",
        foodDescription: "2 large eggs",
        category: "eggs",
        calories: 140,
        proteinG: 12,
        carbsG: 1,
        fatG: 10,
        fiberG: 0,
        saturatedFatG: 3,
        sugarG: 0,
        sodiumMg: 140,
      });
    });
  });

  it("shows fatsecret attribution on the nutrition screen", async () => {
    const { NutritionPage } = await import("./NutritionPage");

    render(<NutritionPage />);

    expect(screen.getByText("Powered by fatsecret Platform API")).toBeTruthy();
  });

  it("keeps existing food entries visible during a background refetch", async () => {
    foodByDateQuery = {
      data: {
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
        resolution: availableResolution,
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
      error: null,
      isFetching: true,
      isLoading: true,
    };
    const { NutritionPage } = await import("./NutritionPage");

    render(<NutritionPage />);

    expect(screen.getByText("Greek yogurt")).toBeTruthy();
    expect(screen.queryByTestId("chart-loading-skeleton")).toBeNull();
  });

  it("renders canonical summary values instead of recalculating from entry rows", async () => {
    foodByDateQuery = {
      data: {
        entries: [
          {
            id: "food-1",
            food_name: "Server-owned nutrition",
            meal: "breakfast",
            calories: 120,
            protein_g: 18,
            carbs_g: 7,
            fat_g: 0,
            food_description: null,
          },
        ],
        resolution: availableResolution,
        summary: {
          calories: 999,
          mealCalories: { breakfast: 777, lunch: 0, dinner: 0, snack: 0, other: 0 },
          calorieGoal: { target: 2200, remaining: 1201, over: 0, progressPercentage: 45.4 },
          macros: {
            protein: { grams: 88, calories: 352, energySharePercentage: 35 },
            carbs: { grams: 111, calories: 444, energySharePercentage: 45 },
            fat: { grams: 22, calories: 198, energySharePercentage: 20 },
          },
        },
      },
      error: null,
      isLoading: false,
    };
    const { NutritionPage } = await import("./NutritionPage");

    render(<NutritionPage />);

    expect(screen.getByText("999 kcal")).toBeTruthy();
    expect(screen.getByText("777 kcal")).toBeTruthy();
    expect(screen.getByText("1,201 kcal remaining")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Share of energy" })).toBeTruthy();
    expect(screen.getByText("35% of energy")).toBeTruthy();
    expect(screen.getByText("88 g logged")).toBeTruthy();
    expect(
      screen.getByRole("meter", {
        name: "Protein: 35% share of energy; 88 grams logged",
      }),
    ).toHaveAttribute("value", "35");
  });

  it("renders an accessible source conflict and leaves totals unavailable", async () => {
    foodByDateQuery = {
      data: {
        entries: [
          {
            id: "food-1",
            food_name: "Named itemized meal",
            meal: "breakfast",
            calories: 420,
            protein_g: 20,
            carbs_g: 50,
            fat_g: 15,
            food_description: null,
          },
        ],
        summary: null,
        resolution: {
          status: "source_conflict",
          message:
            "Totals are unavailable because nutrition sources overlap and no canonical contribution set can be determined.",
          sourceProviders: ["apple-health", "cronometer"],
          contributingProviders: [],
          excludedProviders: ["apple-health", "cronometer"],
          sourceLabels: ["Apple Health", "Cronometer"],
          contributingSourceLabels: [],
          excludedSourceLabels: ["Apple Health", "Cronometer"],
        },
      },
      error: null,
      isLoading: false,
    };
    const { NutritionPage } = await import("./NutritionPage");

    render(<NutritionPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("Totals are unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Apple Health, Cronometer");
    expect(screen.queryByText(/kcal remaining/)).toBeNull();
    expect(screen.getByText("Named itemized meal")).toBeTruthy();
  });
});
