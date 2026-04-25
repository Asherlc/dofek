// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const foodRefetchMock = vi.fn();
const analyzeItemsMutateAsyncMock = vi.fn();
const createFoodMutateMock = vi.fn();
const createAiEntryMutateAsyncMock = vi.fn();
const deleteMutateMock = vi.fn();

vi.mock("../lib/telemetry.ts", () => ({
  captureException: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
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
          error: null,
          isLoading: false,
          refetch: foodRefetchMock,
        }),
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
});
