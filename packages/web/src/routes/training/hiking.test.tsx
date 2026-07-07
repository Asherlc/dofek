/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";

interface QueryCall {
  name: string;
  input: unknown;
  options: unknown;
}

const state = vi.hoisted<{
  capturedRouteComponent: ComponentType | null;
  queryCalls: QueryCall[];
}>(() => ({
  capturedRouteComponent: null,
  queryCalls: [],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: { component: ComponentType }) => {
    state.capturedRouteComponent = config.component;
    return {};
  },
}));

vi.mock("../../components/ActivityComparisonChart.tsx", () => ({
  ActivityComparisonChart: () => <div data-testid="activity-comparison" />,
}));
vi.mock("../../components/ChartDescriptionTooltip.tsx", () => ({
  ChartDescriptionTooltip: () => null,
}));
vi.mock("../../components/ElevationGainChart.tsx", () => ({
  ElevationGainChart: () => <div data-testid="elevation" />,
}));
vi.mock("../../components/GradeAdjustedPaceTable.tsx", () => ({
  GradeAdjustedPaceTable: () => <div data-testid="grade-adjusted-pace" />,
}));
vi.mock("../../components/RecentActivitiesSection.tsx", () => ({
  RecentActivitiesSection: () => <div data-testid="recent-activities" />,
}));
vi.mock("../../components/WalkingBiomechanicsChart.tsx", () => ({
  WalkingBiomechanicsChart: () => <div data-testid="walking-biomechanics" />,
}));

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: 90 }),
}));

function recordQuery(name: string) {
  return (input: unknown, options?: unknown) => {
    state.queryCalls.push({ name, input, options });
    return { data: [], isLoading: false, error: null };
  };
}

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    hiking: {
      gradeAdjustedPace: { useQuery: recordQuery("gradeAdjustedPace") },
      elevationProfile: { useQuery: recordQuery("elevationProfile") },
      walkingBiomechanics: { useQuery: recordQuery("walkingBiomechanics") },
      activityComparison: { useQuery: recordQuery("activityComparison") },
    },
  },
}));

async function renderHikingTab() {
  await import("./hiking.tsx");
  if (!state.capturedRouteComponent) throw new Error("Hiking route component was not captured");
  const HikingTab = state.capturedRouteComponent;
  return render(<HikingTab />);
}

describe("HikingTab", () => {
  beforeEach(() => {
    vi.resetModules();
    state.capturedRouteComponent = null;
    state.queryCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("uses exact selected days for pace and biomechanics, and cached 365-day windows for long-range queries", async () => {
    await renderHikingTab();

    expect(state.queryCalls).toEqual([
      { name: "gradeAdjustedPace", input: { days: 90 }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "elevationProfile", input: { days: 365 }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "walkingBiomechanics", input: { days: 90 }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "activityComparison", input: { days: 365 }, options: TRAINING_SLOW_QUERY_OPTIONS },
    ]);
  });
});
