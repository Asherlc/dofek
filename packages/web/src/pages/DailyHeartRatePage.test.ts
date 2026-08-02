/** @vitest-environment jsdom */
import { formatDateYmd } from "@dofek/format/format";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeartRateSourceSeries } from "../../../server/src/routers/heart-rate.ts";

interface DailyBySourceQueryResult {
  data: HeartRateSourceSeries[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

const { mockDailyBySourceQuery, mockDofekChart } = vi.hoisted(() => ({
  mockDailyBySourceQuery: vi.fn<(input: { date: string }) => DailyBySourceQueryResult>(() => ({
    data: [
      {
        providerId: "apple_health",
        providerLabel: "Apple Health",
        sampleCount: 12,
        minHeartRate: 55,
        avgHeartRate: 63,
        maxHeartRate: 89,
        samples: [
          { time: "2026-07-19T10:00:00.000Z", heartRate: 70 },
          { time: "2026-07-19T10:01:00.000Z", heartRate: 72 },
        ],
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
  })),
  mockDofekChart: vi.fn<(props: { timeRangeMode?: "context" | "data" }) => null>(() => null),
}));

vi.mock("../components/DofekChart.tsx", () => ({
  DofekChart: mockDofekChart,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    heartRate: {
      dailyBySource: { useQuery: mockDailyBySourceQuery },
    },
  },
}));

import { DailyHeartRatePage } from "./DailyHeartRatePage.tsx";

describe("DailyHeartRatePage", () => {
  it("nests its title below the Body page heading", () => {
    mockDailyBySourceQuery.mockReturnValue({
      data: [],
      error: null,
      isError: false,
      isLoading: false,
    });

    render(createElement(DailyHeartRatePage));

    expect(
      screen.getByRole("heading", { level: 2, name: "Daily Heart Rate by Source" }),
    ).toBeTruthy();
  });

  beforeEach(() => {
    mockDailyBySourceQuery.mockClear();
    mockDofekChart.mockClear();
    mockDailyBySourceQuery.mockReturnValue({
      data: [
        {
          providerId: "apple_health",
          providerLabel: "Apple Health",
          sampleCount: 12,
          minHeartRate: 55,
          avgHeartRate: 63,
          maxHeartRate: 89,
          samples: [
            { time: "2026-07-19T10:00:00.000Z", heartRate: 70 },
            { time: "2026-07-19T10:01:00.000Z", heartRate: 72 },
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it("fits the time axis to the selected day's samples", () => {
    render(createElement(DailyHeartRatePage));

    expect(mockDofekChart.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ timeRangeMode: "data" }),
    );
  });

  it("provides accessible day navigation and identifies the local timezone", () => {
    render(createElement(DailyHeartRatePage));

    expect(screen.getByRole("button", { name: "Previous day" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    expect(
      screen.getByText(`Local day in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`),
    ).toBeTruthy();
  });

  it("queries the previous day and returns to today through the controls", () => {
    render(createElement(DailyHeartRatePage));

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    const previousDay = new Date();
    previousDay.setDate(previousDay.getDate() - 1);
    expect(mockDailyBySourceQuery.mock.calls.at(-1)?.[0]).toEqual({
      date: formatDateYmd(previousDay),
    });

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(mockDailyBySourceQuery.mock.calls.at(-1)?.[0]).toEqual({ date: formatDateYmd() });

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(mockDailyBySourceQuery.mock.calls.at(-1)?.[0]).toEqual({ date: formatDateYmd() });
  });

  it("renders the canonical server-provided source summary", () => {
    render(createElement(DailyHeartRatePage));

    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("55 bpm")).toBeTruthy();
    expect(screen.getByText("63 bpm")).toBeTruthy();
    expect(screen.getByText("89 bpm")).toBeTruthy();
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.queryByText("71 bpm")).toBeNull();
  });

  it("renders an explicit loading state before data is available", () => {
    mockDailyBySourceQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });

    render(createElement(DailyHeartRatePage));

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("No heart rate data for this day")).toBeNull();
  });

  it("renders the server error instead of the empty state when the query fails", () => {
    mockDailyBySourceQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("ClickHouse heart-rate query failed"),
    });

    render(createElement(DailyHeartRatePage));

    expect(screen.getByText("ClickHouse heart-rate query failed")).toBeTruthy();
    expect(screen.queryByText("No heart rate data for this day")).toBeNull();
  });
});
