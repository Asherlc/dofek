// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();

let mockWorkloadRatioData: unknown;
let mockActivities: unknown[] = [];
let mockWeeklyVolume: unknown[] = [];

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    recovery: {
      workloadRatio: {
        useQuery: () => ({ data: mockWorkloadRatioData, isLoading: false }),
      },
    },
    training: {
      activityStats: {
        useQuery: () => ({ data: mockActivities, isLoading: false }),
      },
      weeklyVolume: {
        useQuery: () => ({ data: mockWeeklyVolume, isLoading: false }),
      },
    },
  },
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("../../lib/units", async () => {
  const actual = await vi.importActual<typeof import("../../lib/units")>("../../lib/units");
  return {
    ...actual,
    useUnitConverter: () => new actual.UnitConverter("metric"),
  };
});

describe("StrainScreen recent activity navigation", () => {
  beforeEach(() => {
    mockRouterPush.mockReset();
    mockWeeklyVolume = [];
    mockActivities = [];
    mockWorkloadRatioData = {
      displayedStrain: 16,
      displayedDate: "2026-03-28",
      timeSeries: [
        {
          date: "2026-03-28",
          acuteLoad: 27.4,
          chronicLoad: 24.9,
          workloadRatio: 1.1,
          strain: 16,
        },
      ],
    };
  });

  it("navigates to detail screen when a recent activity card is tapped", async () => {
    mockActivities = [
      {
        id: 42,
        name: "Morning Ride",
        activity_type: "cycling",
        started_at: "2026-03-28T07:00:00.000Z",
        ended_at: "2026-03-28T08:00:00.000Z",
        avg_hr: 150,
        max_hr: 178,
        avg_power: 240,
        distance_meters: 24000,
        calories: 640,
      },
    ];

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    fireEvent.click(screen.getByText("Morning Ride"));

    expect(mockRouterPush).toHaveBeenCalledWith("/activity/42");
  });
});
