/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
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
  queryError: Error | null;
  selectedDays: number | null;
}>(() => ({
  capturedRouteComponent: null,
  queryCalls: [],
  queryError: null,
  selectedDays: 90,
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
  useTrainingDays: () => ({ days: state.selectedDays }),
}));

function recordQuery(name: string) {
  return (input: unknown, options?: unknown) => {
    state.queryCalls.push({ name, input, options });
    return { data: [], isLoading: false, error: state.queryError };
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
    state.queryError = null;
    state.selectedDays = 90;
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the selected days for every chart query", async () => {
    state.selectedDays = 30;

    await renderHikingTab();

    expect(state.queryCalls).toEqual([
      { name: "gradeAdjustedPace", input: { days: 30 }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "elevationProfile", input: { days: 30 }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "walkingBiomechanics", input: { days: 30 }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "activityComparison", input: { days: 30 }, options: TRAINING_SLOW_QUERY_OPTIONS },
    ]);
  });

  it("passes null for All to every selected-range chart query", async () => {
    state.selectedDays = null;

    await renderHikingTab();

    expect(state.queryCalls).toEqual([
      { name: "gradeAdjustedPace", input: { days: null }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "elevationProfile", input: { days: null }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "walkingBiomechanics", input: { days: null }, options: TRAINING_SLOW_QUERY_OPTIONS },
      { name: "activityComparison", input: { days: null }, options: TRAINING_SLOW_QUERY_OPTIONS },
    ]);
  });

  it("shows hiking query errors when the only cached data is empty", async () => {
    state.queryError = new Error("Error in input stream");

    await renderHikingTab();

    expect(screen.getAllByText("Error in input stream")).toHaveLength(4);
  });

  it("leads with plain meaning before disclosing the slope-cost model", async () => {
    await renderHikingTab();

    expect(screen.getByRole("heading", { name: /Effort-adjusted pace for grade/i })).toBeDefined();
    expect(screen.getByText(/Pace adjusted.*Minetti slope-cost model/)).toBeDefined();
  });
});
