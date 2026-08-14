// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

describe("NutritionPage", () => {
  it("shows nutrition data without first-party food logging controls", async () => {
    const { NutritionPage } = await import("./NutritionPage");

    render(<NutritionPage />);

    expect(screen.queryByText("AI meal input")).toBeNull();
    expect(screen.queryByRole("button", { name: /add food/i })).toBeNull();
    expect(screen.getByText("Breakfast")).toBeTruthy();
  });
});
