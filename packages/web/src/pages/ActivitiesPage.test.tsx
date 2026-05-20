/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockQuery {
  data: unknown[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

let mockQuery: MockQuery;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    calendar: {
      weekList: {
        useQuery: () => mockQuery,
      },
    },
  },
}));

vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => ({
    formatDistance: (km: number) => `${km.toFixed(1)} km`,
    formatElevation: (meters: number) => `${meters} m`,
  }),
}));

import { ActivitiesPage } from "./ActivitiesPage.tsx";

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    name: "Trainer Ride",
    activityType: "indoor_cycling",
    startedAt: "2026-03-18T07:00:00.000Z",
    endedAt: "2026-03-18T08:00:00.000Z",
    durationMin: 60,
    location: null,
    calories: 421.6,
    tss: 100,
    stats: [
      { label: "Training Stress Score", value: "100" },
      { label: "Calories", value: "422 kcal" },
    ],
    ...overrides,
  };
}

describe("ActivitiesPage", () => {
  beforeEach(() => {
    mockQuery = { data: [], isLoading: false, isError: false, error: null };
  });

  it("uses QueryStatePanel for loading state", () => {
    mockQuery = { data: [], isLoading: true, isError: false, error: null };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("uses QueryStatePanel for empty state", () => {
    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("No activities in the last 4 weeks.")).toBeDefined();
  });

  it("renders server-provided stat labels and values", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Training Stress Score")).toBeDefined();
    expect(screen.getByText("100")).toBeDefined();
    expect(screen.queryByText("TSS")).toBeNull();
  });

  it("replaces failed map tiles with a fallback", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
                distanceMeters: 5000,
                elevationGainM: 120,
              },
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.error(screen.getByAltText("Activity location map"));

    expect(screen.getByText("Map unavailable")).toBeDefined();
  });
});
