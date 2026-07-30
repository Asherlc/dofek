// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDailyBySourceQuery, mockStackScreen } = vi.hoisted(() => ({
  mockDailyBySourceQuery: vi.fn(),
  mockStackScreen: vi.fn(() => null),
}));

function stripStyle({ style: _s, contentContainerStyle: _cs, ...rest }: Record<string, unknown>) {
  return rest;
}

vi.mock("react-native", () => ({
  ActivityIndicator: (props: Record<string, unknown>) =>
    React.createElement("div", { ...props, role: "progressbar" }),
  View: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("span", stripStyle(props), ...(children != null ? [children] : [])),
  ScrollView: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Pressable: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { ...stripStyle(props), type: "button" },
      ...(children != null ? [children] : []),
    ),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => {
      for (const key of Object.keys(styles)) {
        styles[key] = {};
      }
      return styles;
    },
    hairlineWidth: 1,
  },
}));

vi.mock("react-native-svg", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("svg", props, ...(children != null ? [children] : [])),
  Line: (props: Record<string, unknown>) => React.createElement("line", props),
  Polyline: (props: Record<string, unknown>) => React.createElement("polyline", props),
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: mockStackScreen },
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmd: () => "2026-04-12",
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    heartRate: {
      dailyBySource: {
        useQuery: mockDailyBySourceQuery,
      },
    },
  },
}));

vi.mock("../theme", () => ({
  colors: {
    background: "#000",
    surface: "#111",
    surfaceSecondary: "#1a1a1a",
    text: "#fff",
    textSecondary: "#aaa",
    textTertiary: "#666",
    accent: "#00f",
    positive: "#0f0",
    danger: "#f00",
  },
  radius: { xl: 12 },
  spacing: { xs: 4, md: 12, lg: 16 },
}));

vi.mock("./_layout-options", () => ({
  rootStackScreenOptions: {},
}));

describe("DailyHeartRateScreen", () => {
  beforeEach(() => {
    mockStackScreen.mockClear();
    mockDailyBySourceQuery.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it("uses the native navigation title as its single screen heading", async () => {
    const { default: DailyHeartRateScreen } = await import("./daily-heart-rate");

    render(<DailyHeartRateScreen />);

    expect(mockStackScreen).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ title: "Heart Rate by Source" }),
      }),
      undefined,
    );
  });

  it("renders with date navigator and empty state", async () => {
    const { default: DailyHeartRateScreen } = await import("./daily-heart-rate");

    render(<DailyHeartRateScreen />);

    expect(screen.getByText("04/12/2026")).toBeTruthy();
    expect(screen.getByText("No heart rate data for this day")).toBeTruthy();
  });

  it("renders the canonical server-provided source summary", async () => {
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
            { time: "2026-04-12T10:00:00.000Z", heartRate: 70 },
            { time: "2026-04-12T10:01:00.000Z", heartRate: 72 },
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    const { default: DailyHeartRateScreen } = await import("./daily-heart-rate");

    render(<DailyHeartRateScreen />);

    expect(screen.getByText("12 samples")).toBeTruthy();
    expect(screen.getByText("55")).toBeTruthy();
    expect(screen.getByText("63")).toBeTruthy();
    expect(screen.getByText("89")).toBeTruthy();
    expect(screen.queryByText("2 samples")).toBeNull();
    expect(screen.queryByText("71")).toBeNull();
  });

  it("renders an explicit loading state before data is available", async () => {
    mockDailyBySourceQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });
    const { default: DailyHeartRateScreen } = await import("./daily-heart-rate");

    render(<DailyHeartRateScreen />);

    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByText("No heart rate data for this day")).toBeNull();
  });

  it("renders the server error instead of the empty state when the query fails", async () => {
    mockDailyBySourceQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("ClickHouse heart-rate query failed"),
    });
    const { default: DailyHeartRateScreen } = await import("./daily-heart-rate");

    render(<DailyHeartRateScreen />);

    expect(screen.getByText("ClickHouse heart-rate query failed")).toBeTruthy();
    expect(screen.queryByText("No heart rate data for this day")).toBeNull();
  });
});
