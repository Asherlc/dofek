// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const foodRefetchMock = vi.fn();
const analyzeItemsMutateAsyncMock = vi.fn();
const createAiEntryMutateAsyncMock = vi.fn();
const deleteMutateMock = vi.fn();

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
  },
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

describe("FoodScreen", () => {
  it("shows synced food data without first-party food logging controls", async () => {
    const { default: FoodScreen } = await import("./food");

    render(<FoodScreen />);

    expect(screen.queryByText("AI meal input")).toBeNull();
    expect(screen.queryByText("+ Add food")).toBeNull();
    expect(screen.getByText("Breakfast")).toBeTruthy();
  });
});
