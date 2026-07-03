// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const foodRefetchMock = vi.fn();
const analyzeItemsMutateAsyncMock = vi.fn();
const createAiEntryMutateAsyncMock = vi.fn();
const deleteMutateMock = vi.fn();
const loggerInfoMock = vi.fn();
const openExternalUrlMock = vi.fn(() => Promise.resolve(true));
const invalidateFoodByDateMock = vi.fn(() => Promise.resolve());
const invalidateSettingsGetMock = vi.fn(() => Promise.resolve());
const mockUseRefresh = vi.fn((_options: { invalidate?: () => Promise<void> } | undefined) => ({
  refreshing: false,
  onRefresh: vi.fn(),
}));

vi.mock("../../lib/open-external-url", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    settings: {
      get: {
        useQuery: () => ({ data: { value: 2000 } }),
      },
    },
    food: {
      byDate: {
        useQuery: () => ({
          data: [],
          isError: false,
          isLoading: false,
          refetch: foodRefetchMock,
        }),
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
        byDate: { invalidate: invalidateFoodByDateMock },
      },
      settings: {
        get: { invalidate: invalidateSettingsGetMock },
      },
    }),
  },
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (options: { invalidate?: () => Promise<void> } | undefined) =>
    mockUseRefresh(options),
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: vi.fn(),
  logger: {
    info: loggerInfoMock,
  },
}));

describe("FoodScreen AI meal confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouterPush.mockClear();
    openExternalUrlMock.mockClear();
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

  it("scopes pull-to-refresh to food entries and calorie goal", async () => {
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    const refreshOptions = mockUseRefresh.mock.calls.at(-1)?.[0];
    await refreshOptions?.invalidate?.();

    expect(invalidateFoodByDateMock).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(invalidateSettingsGetMock).toHaveBeenCalledWith({ key: "calorieGoal" });
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
});
