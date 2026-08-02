// @vitest-environment jsdom

import type { SelectedDateNutritionIntakeContext } from "@dofek/nutrition/selected-date-summary";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const foodRefetchMock = vi.fn();
const analyzeItemsMutateAsyncMock = vi.fn();
const createAiEntryMutateAsyncMock = vi.fn();
const deleteMutateMock = vi.fn();
const loggerInfoMock = vi.fn();
const captureExceptionMock = vi.fn();
const openExternalUrlMock = vi.fn(() => Promise.resolve(true));
const invalidateFoodByDateMock = vi.fn(() => Promise.resolve());
const mockUseRefresh = vi.fn((_options: { invalidate?: () => Promise<void> } | undefined) => ({
  refreshing: false,
  onRefresh: vi.fn(),
}));
let foodByDateQuery: {
  data: unknown;
  error?: Error | null;
  isError: boolean;
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
  contributionGrain: "itemized",
  contributionLabel: "Dofek itemized entries",
};
const defaultIntakeContext = {
  observedCalories: 0,
  target: {
    calories: 2000,
    type: "default",
    label: "Default daily logged-intake target",
  },
  scale: { maximumCalories: 2000, observedPercentage: 0, targetPercentage: 100 },
  comparison: {
    status: "below_target",
    differenceCalories: 2000,
    message: "Observed logged intake is 2,000 kcal below the default daily logged-intake target.",
  },
  limitation:
    "This target describes logged intake only; it is not an estimate of energy expenditure or calorie balance.",
} satisfies SelectedDateNutritionIntakeContext;

vi.mock("../../lib/open-external-url", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    food: {
      byDateV2: {
        useQuery: () => ({ ...foodByDateQuery, refetch: foodRefetchMock }),
      },
      analyzeItemsWithAi: {
        useMutation: () => ({ mutateAsync: analyzeItemsMutateAsyncMock, isPending: false }),
      },
      create: {
        useMutation: () => ({ mutateAsync: createAiEntryMutateAsyncMock, isPending: false }),
      },
      delete: {
        useMutation: () => ({ mutate: deleteMutateMock, isPending: false }),
      },
    },
    useUtils: () => ({
      food: {
        byDateV2: { invalidate: invalidateFoodByDateMock },
      },
    }),
  },
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (options: { invalidate?: () => Promise<void> } | undefined) =>
    mockUseRefresh(options),
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: captureExceptionMock,
  logger: {
    info: loggerInfoMock,
  },
}));

describe("FoodScreen AI meal confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouterPush.mockClear();
    openExternalUrlMock.mockClear();
    foodByDateQuery = {
      data: {
        entries: [],
        resolution: availableResolution,
        intakeContext: defaultIntakeContext,
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
      isError: false,
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

  it("scopes pull-to-refresh to the selected-date food DTO", async () => {
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    const refreshOptions = mockUseRefresh.mock.calls.at(-1)?.[0];
    await refreshOptions?.invalidate?.();

    expect(invalidateFoodByDateMock).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("waits for confirmation before creating AI parsed food entries", async () => {
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    fireEvent.input(screen.getByPlaceholderText(/two eggs/i), {
      target: { value: "two eggs" },
    });
    fireEvent.click(screen.getByText("Log with AI"));

    await screen.findByText("Review AI meal");

    expect(screen.getByText("Eggs")).toBeTruthy();
    expect(createAiEntryMutateAsyncMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Confirm and log"));

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

  it("opens every food input mode from the nutrition screen", async () => {
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    fireEvent.click(screen.getByText("Search"));
    expect(mockRouterPush).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\/food\/add\?meal=[a-z]+&date=\d{4}-\d{2}-\d{2}&mode=search$/),
    );

    fireEvent.click(screen.getByText("Scan"));
    expect(mockRouterPush).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\/food\/add\?meal=[a-z]+&date=\d{4}-\d{2}-\d{2}&mode=scan$/),
    );

    fireEvent.click(screen.getByText("Quick Add"));
    expect(mockRouterPush).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\/food\/add\?meal=[a-z]+&date=\d{4}-\d{2}-\d{2}&mode=quickadd$/),
    );

    fireEvent.click(screen.getByText("AI"));
    expect(mockRouterPush).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\/food\/add\?meal=[a-z]+&date=\d{4}-\d{2}-\d{2}&mode=ai$/),
    );
  });

  it("records a screen breadcrumb when the nutrition tab renders", async () => {
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(loggerInfoMock).toHaveBeenCalledWith("screen-navigation", "Nutrition tab rendered", {
      route: "food",
    });
  });

  it("opens fatsecret when pressing the food screen attribution", async () => {
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    fireEvent.click(
      screen.getByRole("link", {
        name: "Powered by fatsecret nutrition API (www.fatsecret.com)",
      }),
    );

    expect(openExternalUrlMock).toHaveBeenCalledWith("https://www.fatsecret.com/", "food");
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
        intakeContext: {
          observedCalories: 120,
          target: {
            calories: 2000,
            type: "default",
            label: "Default daily logged-intake target",
          },
          scale: { maximumCalories: 2000, observedPercentage: 6, targetPercentage: 100 },
          comparison: {
            status: "below_target",
            differenceCalories: 1880,
            message:
              "Observed logged intake is 1,880 kcal below the default daily logged-intake target.",
          },
          limitation: defaultIntakeContext.limitation,
        },
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
      isFetching: true,
      isLoading: true,
    };
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(screen.getByText("Greek yogurt")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();
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
        intakeContext: {
          observedCalories: 999,
          target: {
            calories: 2200,
            type: "configured",
            label: "Configured daily logged-intake target",
          },
          scale: {
            maximumCalories: 2200,
            observedPercentage: (999 / 2200) * 100,
            targetPercentage: 100,
          },
          comparison: {
            status: "below_target",
            differenceCalories: 1201,
            message:
              "Observed logged intake is 1,201 kcal below the configured daily logged-intake target.",
          },
          limitation: defaultIntakeContext.limitation,
        },
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
      isError: false,
      isLoading: false,
    };
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(screen.getByText("999 kcal")).toBeTruthy();
    expect(screen.getByText("777 kcal")).toBeTruthy();
    expect(
      screen.getByText(
        "Observed logged intake is 1,201 kcal below the configured daily logged-intake target.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Share of energy")).toBeTruthy();
    expect(screen.getByText("35%")).toBeTruthy();
    expect(screen.getByText("88 g logged")).toBeTruthy();
    expect(screen.getByLabelText("Protein: 35% share of energy; 88 grams logged")).toBeTruthy();
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
        intakeContext: null,
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
          contributionGrain: null,
          contributionLabel: null,
        },
      },
      isError: false,
      isLoading: false,
    };
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(screen.getByRole("alert").textContent).toContain("Totals are unavailable");
    expect(screen.getByRole("alert").textContent).toContain("Apple Health, Cronometer");
    expect(screen.queryByText(/kcal remaining/)).toBeNull();
    expect(screen.getByText("Named itemized meal")).toBeTruthy();
  });

  it("explains an aggregate-only contribution without rendering an unnamed meal", async () => {
    foodByDateQuery = {
      data: {
        entries: [],
        intakeContext: {
          observedCalories: 1800,
          target: {
            calories: 2000,
            type: "default",
            label: "Default daily logged-intake target",
          },
          scale: { maximumCalories: 2000, observedPercentage: 90, targetPercentage: 100 },
          comparison: {
            status: "below_target",
            differenceCalories: 200,
            message:
              "Observed logged intake is 200 kcal below the default daily logged-intake target.",
          },
          limitation: defaultIntakeContext.limitation,
        },
        summary: {
          calories: 1800,
          mealCalories: { breakfast: 0, lunch: 0, dinner: 0, snack: 0, other: 1800 },
          calorieGoal: { target: 2000, remaining: 200, over: 0, progressPercentage: 90 },
          macros: {
            protein: { grams: 90, calories: 360, energySharePercentage: 20 },
            carbs: { grams: 220, calories: 880, energySharePercentage: 50 },
            fat: { grams: 60, calories: 540, energySharePercentage: 30 },
          },
        },
        resolution: {
          status: "available",
          message: "Totals use the only available nutrition source.",
          sourceProviders: ["apple_health"],
          contributingProviders: ["apple_health"],
          excludedProviders: [],
          sourceLabels: ["Cronometer (via Apple Health)"],
          contributingSourceLabels: ["Cronometer (via Apple Health)"],
          excludedSourceLabels: [],
          contributionGrain: "daily_aggregate",
          contributionLabel: "Cronometer (via Apple Health) daily total",
        },
      },
      isError: false,
      isLoading: false,
    };
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(screen.getByText("Cronometer (via Apple Health) daily total")).toBeTruthy();
    expect(screen.getByText("Totals use the only available nutrition source.")).toBeTruthy();
    expect(screen.queryByText("Unnamed nutrition entry")).toBeNull();
  });

  it("does not report missing food data while the first request is loading", async () => {
    foodByDateQuery = {
      data: undefined,
      isError: false,
      isFetching: true,
      isLoading: true,
    };
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("shows the server error message when loading food fails", async () => {
    foodByDateQuery = {
      data: undefined,
      error: new Error("Nutrition data is unavailable for this date."),
      isError: true,
      isLoading: false,
    };
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(screen.getByText("Nutrition data is unavailable for this date.")).toBeTruthy();
    expect(screen.queryByText("Failed to load food entries.")).toBeNull();
  });
});
