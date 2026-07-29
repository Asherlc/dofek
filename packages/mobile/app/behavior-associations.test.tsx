// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted<{
  query: ReturnType<typeof vi.fn>;
  queryInputs: Array<{ days: number }>;
  refetch: ReturnType<typeof vi.fn>;
}>(() => ({
  query: vi.fn(),
  queryInputs: [],
  refetch: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    behaviorImpact: {
      impactSummary: {
        useQuery: (input: { days: number }) => {
          mocks.queryInputs.push(input);
          return mocks.query();
        },
      },
    },
  },
}));

describe("BehaviorAssociationsScreen", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.queryInputs.length = 0;
    mocks.refetch.mockReset();
    mocks.query.mockReturnValue({
      data: [
        {
          questionSlug: "meditation",
          displayName: "Meditation",
          category: "wellness",
          readinessDifferencePercent: 18.6,
          yesCount: 18,
          noCount: 24,
        },
        {
          questionSlug: "late-meal",
          displayName: "Late meal",
          category: "nutrition",
          readinessDifferencePercent: -12.4,
          yesCount: 14,
          noCount: 28,
        },
      ],
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });
  });

  it("presents descriptive associations with method, samples, window, and interval status", async () => {
    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Behavior Associations")).toBeTruthy();
    expect(
      screen.getByText("How your daily behaviors are associated with next-day readiness"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Method: (mean next-day readiness after Yes − mean after No) ÷ mean after No × 100.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Association does not establish causation.")).toBeTruthy();
    expect(
      screen.getByText("Uncertainty interval: not available for this descriptive comparison."),
    ).toBeTruthy();
    expect(screen.getByText("Selected window: 90 days")).toBeTruthy();
    expect(screen.getByText("Yes n = 18 · No n = 24")).toBeTruthy();
    expect(screen.getByText("Yes n = 14 · No n = 28")).toBeTruthy();
    expect(screen.getByText("18.6% higher")).toBeTruthy();
    expect(screen.getByText("12.4% lower")).toBeTruthy();
    expect(mocks.queryInputs.at(-1)).toEqual({ days: 90 });
  });

  it("queries the selected observation window", async () => {
    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "30d" }));

    expect(screen.getByText("Selected window: 30 days")).toBeTruthy();
    expect(mocks.queryInputs.at(-1)).toEqual({ days: 30 });
  });

  it("uses association language in the insufficient-data state", async () => {
    mocks.query.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(
      screen.getByText(
        "Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness.",
      ),
    ).toBeTruthy();
  });

  it("surfaces the server error and retries it", async () => {
    mocks.query.mockReturnValue({
      data: undefined,
      error: new Error("Behavior association data is unavailable."),
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Behavior association data is unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
