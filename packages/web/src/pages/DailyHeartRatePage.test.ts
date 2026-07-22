/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const { mockDailyBySourceQuery, mockDofekChart } = vi.hoisted(() => ({
  mockDailyBySourceQuery: vi.fn(() => ({
    data: [
      {
        providerId: "apple_health",
        providerLabel: "Apple Health",
        samples: [
          { time: "2026-07-19T10:00:00.000Z", heartRate: 70 },
          { time: "2026-07-19T10:01:00.000Z", heartRate: 72 },
        ],
      },
    ],
    isLoading: false,
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
  it("fits the time axis to the selected day's samples", () => {
    render(createElement(DailyHeartRatePage));

    expect(mockDofekChart.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ timeRangeMode: "data" }),
    );
  });
});
