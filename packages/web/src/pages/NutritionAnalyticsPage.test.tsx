// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to,
  }: {
    children: ReactNode;
    search?: { tab?: string };
    to: string;
  }) => <a href={`${to}${search?.tab ? `?tab=${search.tab}` : ""}`}>{children}</a>,
}));

vi.mock("../components/AdaptiveTdeeChart.tsx", () => ({
  AdaptiveTdeeChart: ({ data }: { data?: { estimatedTdee: number | null } }) => (
    <div>{data ? `TDEE: ${data.estimatedTdee}` : "No TDEE payload"}</div>
  ),
}));
vi.mock("../components/ChartDescriptionTooltip.tsx", () => ({
  ChartDescriptionTooltip: () => null,
}));
vi.mock("../components/DofekChart.tsx", () => ({
  ChartRangeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/MicronutrientChart.tsx", () => ({
  MicronutrientChart: ({ data }: { data: unknown[] }) => (
    <div>Micronutrient rows: {data.length}</div>
  ),
}));
vi.mock("../components/TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: () => null,
}));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    nutritionAnalytics: {
      adaptiveTdee: { useQuery: mocks.adaptiveTdee },
      macroRatios: { useQuery: mocks.macroRatios },
      micronutrientAdequacyV2: { useQuery: mocks.micronutrients },
    },
  },
}));

import { NutritionAnalyticsPage } from "./NutritionAnalyticsPage.tsx";

describe("NutritionAnalyticsPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.adaptiveTdeeRefetch.mockReset();
    mocks.macroRatiosRefetch.mockReset();
    mocks.micronutrientsRefetch.mockReset();
    mocks.adaptiveTdee.mockReturnValue(
      queryResult(mocks.adaptiveTdeeRefetch, {
        data: {
          estimatedTdee: 2_250,
          dailyData: [],
        },
      }),
    );
    mocks.macroRatios.mockReturnValue(
      queryResult(mocks.macroRatiosRefetch, {
        data: [
          {
            date: "2026-07-28",
            proteinPct: 30,
            carbsPct: 40,
            fatPct: 30,
            proteinPerKg: 1.7,
          },
        ],
      }),
    );
    mocks.micronutrients.mockReturnValue(
      queryResult(mocks.micronutrientsRefetch, {
        data: {
          nutrients: [{ nutrient: "Iron" }],
          dataQuality: {
            selectedWindowDays: 90,
            daysWithData: 30,
            usableDays: 30,
            overlapDays: 0,
            conflictDays: 0,
            completenessPercent: 100,
            sourceLabels: [],
            contributingSourceLabels: [],
            excludedSourceLabels: [],
          },
        },
      }),
    );
  });

  it("consolidates query failures into one exact root error and one recovery action", () => {
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

    render(<NutritionAnalyticsPage />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Body measurements are unavailable.")).toBeTruthy();
    expect(screen.queryByText("Macro analytics are unavailable.")).toBeNull();
    expect(screen.getByRole("link", { name: "Review data sources" }).getAttribute("href")).toBe(
      "/settings?tab=data-sources",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry nutrition analytics" }));

    expect(mocks.adaptiveTdeeRefetch).toHaveBeenCalledOnce();
    expect(mocks.macroRatiosRefetch).toHaveBeenCalledOnce();
    expect(mocks.micronutrientsRefetch).toHaveBeenCalledOnce();
  });

  it("keeps cached analytics visible behind one background-refresh error", () => {
    mocks.adaptiveTdee.mockReturnValue(
      queryResult(mocks.adaptiveTdeeRefetch, {
        data: {
          estimatedTdee: 2_250,
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
          nutrients: [{ nutrient: "Iron" }],
          dataQuality: {
            selectedWindowDays: 90,
            daysWithData: 30,
            usableDays: 30,
            overlapDays: 0,
            conflictDays: 0,
            completenessPercent: 100,
            sourceLabels: [],
            contributingSourceLabels: [],
            excludedSourceLabels: [],
          },
        },
        error: new Error("Micronutrient refresh failed."),
        isError: true,
        isFetching: true,
        isSuccess: false,
      }),
    );

    render(<NutritionAnalyticsPage />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Nutrition analytics refresh failed.")).toBeTruthy();
    expect(screen.getByText("TDEE: 2250")).toBeTruthy();
    expect(screen.getByText("Micronutrient rows: 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retrying..." })).toBeDisabled();
  });
});
