/** @vitest-environment jsdom */

import type { DataQualityOverview } from "@dofek/format/data-quality";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockQuery {
  data?: DataQualityOverview;
  error: Error | null;
  isFetching: boolean;
  isLoading: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

const queryMocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  useQuery: vi.fn<() => MockQuery>(),
}));

vi.mock("../components/DataQualityCenter.tsx", () => ({
  DataQualityCenter: ({ data }: { data: DataQualityOverview }) => (
    <div data-testid="data-quality-center">
      <h2>Data quality center</h2>
      <p>{data.overallMessage}</p>
    </div>
  ),
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

vi.mock("../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({
    error,
    message,
    onRetry,
    title,
    variant = error ? "error" : "empty",
  }: {
    error?: unknown;
    message?: ReactNode;
    onRetry?: () => void;
    title?: string;
    variant?: "loading" | "error" | "empty";
  }) => (
    <section data-testid={`query-state-${variant}`}>
      {title ? <h2>{title}</h2> : null}
      {message ?? (error instanceof Error ? error.message : null)}
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  ),
}));

vi.mock("../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-07-22",
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    processing: {
      dataQuality: { useQuery: queryMocks.useQuery },
    },
  },
}));

import { DataQualityPage } from "./DataQualityPage.tsx";

const overview: DataQualityOverview = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  window: { days: 30, endDate: "2026-07-22" },
  overallStatus: "healthy",
  overallMessage: "Your recent data is ready to interpret.",
  checks: [],
};

function queryResult(overrides: Partial<MockQuery> = {}): MockQuery {
  return {
    data: undefined,
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: queryMocks.refetch,
    ...overrides,
  };
}

describe("DataQualityPage", () => {
  beforeEach(() => {
    queryMocks.refetch.mockReset();
    queryMocks.useQuery.mockReset();
    queryMocks.useQuery.mockReturnValue(queryResult());
  });

  afterEach(cleanup);

  it("shows loading before the first overview is available", () => {
    queryMocks.useQuery.mockReturnValue(queryResult({ isLoading: true }));

    render(<DataQualityPage />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByTestId("data-quality-center")).toBeNull();
  });

  it("shows the initial server error and retries it", () => {
    queryMocks.useQuery.mockReturnValue(
      queryResult({ error: new Error("Data quality query failed") }),
    );

    render(<DataQualityPage />);

    expect(screen.getByText("Data quality query failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(queryMocks.refetch).toHaveBeenCalledOnce();
  });

  it("shows the empty state when the server returns no overview", () => {
    render(<DataQualityPage />);

    expect(screen.getByTestId("query-state-empty")).toHaveTextContent(
      "No data quality checks are available yet.",
    );
  });

  it("renders the successful server-owned overview", () => {
    queryMocks.useQuery.mockReturnValue(queryResult({ data: overview }));

    render(<DataQualityPage />);

    expect(screen.getByTestId("data-quality-center")).toHaveTextContent(
      "Your recent data is ready to interpret.",
    );
    expect(screen.queryByTestId("query-state-error")).toBeNull();
  });

  it("retains the overview while a background refresh fails", () => {
    queryMocks.useQuery.mockReturnValue(
      queryResult({
        data: overview,
        error: new Error("Data quality refresh failed"),
        isFetching: true,
      }),
    );

    render(<DataQualityPage />);

    expect(screen.getByTestId("data-quality-center")).toBeTruthy();
    expect(
      within(screen.getByTestId("query-state-error")).getByRole("heading", {
        name: "Data quality refresh failed",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(queryMocks.refetch).toHaveBeenCalledOnce();
  });
});
