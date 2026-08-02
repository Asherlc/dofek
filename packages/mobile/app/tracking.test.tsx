// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted<{
  query: ReturnType<typeof vi.fn>;
  queryInputs: Array<{ days: number; endDate: string }>;
  refetch: ReturnType<typeof vi.fn>;
}>(() => ({
  query: vi.fn(),
  queryInputs: [],
  refetch: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    journal: {
      trends: {
        useQuery: (input: { days: number; endDate: string }) => {
          mocks.queryInputs.push(input);
          return mocks.query();
        },
      },
    },
  },
}));

vi.mock("../lib/useTimeRangePreference", async () => {
  const { useState } = await import("react");
  return {
    useTimeRangePreference: () => {
      const [days, setDays] = useState(90);
      return {
        days,
        defaultDays: 90,
        description: "Shared behavior observation window.",
        isHydrated: true,
        setDays,
      };
    },
  };
});

const trendEvidence = {
  window: {
    startDate: "2026-07-23",
    endDate: "2026-07-25",
    dayCount: 3,
    gapRepresentation: "explicit_daily" as const,
  },
  statement:
    "3 exact observations across 2 of 3 days. Missing days indicate no journal value was recorded.",
  uncertainty: {
    status: "unavailable" as const,
    statement: "Uncertainty interval: not available for raw journal observations.",
  },
  series: [
    {
      questionSlug: "alcohol",
      displayName: "Alcohol",
      dataType: "boolean" as const,
      unit: null,
      observationCount: 2,
      observedDayCount: 2,
      missingDayCount: 1,
      statement: "2 exact observations across 2 of 3 days; 1 day has no recorded value.",
      points: [
        {
          date: "2026-07-23",
          value: 1,
          source: { providerId: "dofek", label: "Dofek" },
        },
        {
          date: "2026-07-24",
          value: 0,
          source: { providerId: "whoop", label: "WHOOP (Cloud)" },
        },
        { date: "2026-07-25", value: null, source: null },
      ],
    },
    {
      questionSlug: "energy",
      displayName: "Energy",
      dataType: "numeric" as const,
      unit: "/10",
      observationCount: 1,
      observedDayCount: 1,
      missingDayCount: 2,
      statement: "1 exact observation across 1 of 3 days; 2 days have no recorded value.",
      points: [
        { date: "2026-07-23", value: null, source: null },
        {
          date: "2026-07-24",
          value: 8,
          source: { providerId: "dofek", label: "Dofek" },
        },
        { date: "2026-07-25", value: null, source: null },
      ],
    },
  ],
};

describe("TrackingScreen", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.queryInputs.length = 0;
    mocks.refetch.mockReset();
    mocks.query.mockReturnValue({
      data: trendEvidence,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });
  });

  it("renders server-authored dates, gaps, exact values, and interval status", async () => {
    const { default: TrackingScreen } = await import("./tracking");
    render(<TrackingScreen />);

    expect(screen.getByText("Journal Trends")).toBeTruthy();
    expect(screen.getByText("Jul 23, 2026 – Jul 25, 2026")).toBeTruthy();
    expect(screen.getByText(trendEvidence.statement)).toBeTruthy();
    expect(screen.getByText(trendEvidence.uncertainty.statement)).toBeTruthy();
    expect(screen.getByText(trendEvidence.series[0].statement)).toBeTruthy();
    expect(screen.getByText("Missing: Sat, Jul 25, 2026")).toBeTruthy();
    expect(screen.getByText("Thu, Jul 23, 2026: Yes · Dofek")).toBeTruthy();
    expect(screen.getByText("Fri, Jul 24, 2026: No · WHOOP (Cloud)")).toBeTruthy();
    expect(screen.getByText("Fri, Jul 24, 2026: 8 /10 · Dofek")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Alcohol journal trend from Jul 23, 2026 to Jul 25, 2026. Missing days are marked as hollow circles. Exact values are listed below.",
      ),
    ).toBeTruthy();
    expect(mocks.queryInputs.at(-1)).toMatchObject({ days: 90 });
    expect(mocks.queryInputs.at(-1)?.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("queries the selected observation window", async () => {
    const { default: TrackingScreen } = await import("./tracking");
    render(<TrackingScreen />);

    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expect(mocks.queryInputs.at(-1)).toMatchObject({ days: 7 });
  });

  it("does not connect same-day numeric provider observations", async () => {
    mocks.query.mockReturnValue({
      data: {
        ...trendEvidence,
        series: [
          {
            questionSlug: "energy",
            displayName: "Energy",
            dataType: "numeric",
            unit: "/10",
            observationCount: 3,
            observedDayCount: 2,
            missingDayCount: 0,
            statement: "3 exact observations across 2 of 2 days; 0 days have no recorded value.",
            points: [
              {
                date: "2026-07-24",
                value: 7,
                source: { providerId: "dofek", label: "Dofek" },
              },
              {
                date: "2026-07-24",
                value: 8,
                source: { providerId: "whoop", label: "WHOOP (Cloud)" },
              },
              {
                date: "2026-07-25",
                value: 9,
                source: { providerId: "dofek", label: "Dofek" },
              },
            ],
          },
        ],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: TrackingScreen } = await import("./tracking");
    const { container } = render(<TrackingScreen />);

    expect(container.querySelector("path")).toBeNull();
    expect(
      screen.getByLabelText(
        "Energy journal trend from Jul 23, 2026 to Jul 25, 2026. Multiple sources recorded the same date, so observations are shown as separate points. Exact values are listed below.",
      ),
    ).toBeTruthy();
  });

  it("surfaces the server error and retries it", async () => {
    mocks.query.mockReturnValue({
      data: undefined,
      error: new Error("Journal trend evidence is unavailable."),
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: TrackingScreen } = await import("./tracking");
    render(<TrackingScreen />);

    expect(screen.getByText("Journal trend evidence is unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry journal trends" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("shows an explicit empty state", async () => {
    mocks.query.mockReturnValue({
      data: { ...trendEvidence, series: [] },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: TrackingScreen } = await import("./tracking");
    render(<TrackingScreen />);

    expect(screen.getByText("No numeric journal data to chart")).toBeTruthy();
    expect(
      screen.getByText("Log a numeric or Yes/No journal value to start reviewing trends."),
    ).toBeTruthy();
  });

  it("keeps cached evidence and retry visible after a refresh error", async () => {
    mocks.query.mockReturnValue({
      data: trendEvidence,
      error: new Error("Journal trend refresh failed."),
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: TrackingScreen } = await import("./tracking");
    render(<TrackingScreen />);

    expect(screen.getByText(trendEvidence.statement)).toBeTruthy();
    expect(screen.getByText("Journal trend refresh failed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry journal trends" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
