/** @vitest-environment jsdom */

import type { DataQualityCheckKey, DataQualityOverview } from "@dofek/format/data-quality";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockQuery {
  data?: DataQualityOverview;
  error: Error | null;
  isFetching: boolean;
  isLoading: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  routerPush: vi.fn(),
  useQuery: vi.fn<() => MockQuery>(),
}));

vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T): T => styles },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("../components/DataQualityCenter", () => ({
  DataQualityCenter: ({
    data,
    onReview,
  }: {
    data: DataQualityOverview;
    onReview?: (key: DataQualityCheckKey) => void;
  }) => {
    const labels: Record<DataQualityCheckKey, string> = {
      coverage: "Review nutrition",
      source_overlap: "Review nutrition",
      activity_source_overlap: "Review activities",
      sync_freshness: "Review dashboard",
      outliers: "Review dashboard",
      manual_edits: "Review journal",
    };
    return (
      <div data-testid="data-quality-center">
        <p>{data.overallMessage}</p>
        {data.checks.map((check) => (
          <button type="button" key={check.key} onClick={() => onReview?.(check.key)}>
            {labels[check.key]}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("../components/QueryStatePanel", () => ({
  QueryStatePanel: ({
    error,
    message,
    onRetry,
    title,
    variant = "empty",
  }: {
    error?: unknown;
    message?: string;
    onRetry?: () => void;
    title?: string;
    variant?: "loading" | "error" | "empty";
  }) => (
    <section data-testid={`query-state-${variant}`}>
      {title ? <h2>{title}</h2> : null}
      <p>{message ?? (error instanceof Error ? error.message : null)}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  ),
  getQueryErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Unknown error",
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    processing: {
      dataQuality: { useQuery: mocks.useQuery },
    },
  },
}));

vi.mock("../lib/useTodayQueryDate", () => ({
  useTodayQueryDate: () => "2026-07-22",
}));

vi.mock("../theme", () => ({
  colors: { background: "#fff", textSecondary: "#666" },
  spacing: { md: 12, xl: 24 },
}));

import DataQualityScreen from "./data-quality";

const overview: DataQualityOverview = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  window: { days: 30, endDate: "2026-07-22" },
  overallStatus: "attention",
  overallMessage: "2 data quality checks need review.",
  checks: [
    {
      key: "coverage",
      label: "Missing days",
      status: "attention",
      title: "Coverage gaps",
      message: "Nutrition data is missing for 5 of the last 30 days.",
      count: 5,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "source_overlap",
      label: "Source overlap",
      status: "attention",
      title: "Some records have overlapping sources",
      message: "Review the source decisions before interpreting these records.",
      count: 2,
      lastObservedDate: "2026-07-21",
      details: [],
    },
    {
      key: "activity_source_overlap",
      label: "Activity source overlap",
      status: "attention",
      title: "Activity sources overlap",
      message: "Review activity source records before interpreting them.",
      count: 1,
      lastObservedDate: "2026-07-21",
      details: [],
    },
    {
      key: "sync_freshness",
      label: "Sync freshness",
      status: "healthy",
      title: "Data updates are current",
      message: "All selected datasets are ready.",
      count: 0,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "outliers",
      label: "Outliers",
      status: "informational",
      title: "No unusual observations were flagged",
      message: "No unusual observations were flagged in the last 30 days.",
      count: 0,
      lastObservedDate: null,
      details: [],
    },
    {
      key: "manual_edits",
      label: "Manual edits",
      status: "informational",
      title: "Manual entries are included",
      message: "1 manually entered journal record was recorded in the last 30 days.",
      count: 1,
      lastObservedDate: "2026-07-19",
      details: [],
    },
  ],
};

function queryResult(overrides: Partial<MockQuery> = {}): MockQuery {
  return {
    data: undefined,
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: mocks.refetch,
    ...overrides,
  };
}

describe("DataQualityScreen", () => {
  beforeEach(() => {
    mocks.refetch.mockReset();
    mocks.routerPush.mockReset();
    mocks.useQuery.mockReset();
    mocks.useQuery.mockReturnValue(queryResult());
  });

  afterEach(cleanup);

  it("shows loading before the first overview is available", () => {
    mocks.useQuery.mockReturnValue(queryResult({ isLoading: true }));

    render(<DataQualityScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByTestId("data-quality-center")).toBeNull();
  });

  it("shows the initial server error and retries it", () => {
    mocks.useQuery.mockReturnValue(queryResult({ error: new Error("Data quality query failed") }));

    render(<DataQualityScreen />);

    expect(screen.getByText("Data quality query failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("shows the empty state when the server returns no overview", () => {
    render(<DataQualityScreen />);

    expect(screen.getByTestId("query-state-empty").textContent).toContain(
      "No data quality checks are available yet.",
    );
  });

  it("renders the overview and routes every review destination", () => {
    mocks.useQuery.mockReturnValue(queryResult({ data: overview }));

    render(<DataQualityScreen />);

    expect(screen.getByTestId("data-quality-center").textContent).toContain(
      "2 data quality checks need review.",
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Review nutrition" })[0]);
    expect(mocks.routerPush).toHaveBeenLastCalledWith("/nutrition-analytics");
    fireEvent.click(screen.getAllByRole("button", { name: "Review dashboard" })[0]);
    expect(mocks.routerPush).toHaveBeenLastCalledWith("/(tabs)");
    fireEvent.click(screen.getByRole("button", { name: "Review activities" }));
    expect(mocks.routerPush).toHaveBeenLastCalledWith("/activities");
    fireEvent.click(screen.getByRole("button", { name: "Review journal" }));
    expect(mocks.routerPush).toHaveBeenLastCalledWith("/tracking");
  });

  it("retains the overview while a background refresh fails", () => {
    mocks.useQuery.mockReturnValue(
      queryResult({
        data: overview,
        error: new Error("Data quality refresh failed"),
        isFetching: true,
      }),
    );

    render(<DataQualityScreen />);

    expect(screen.getByTestId("data-quality-center")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Data quality refresh failed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
