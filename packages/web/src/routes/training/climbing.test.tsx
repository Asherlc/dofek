/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gradeProgressionQuery = vi.hoisted(() => vi.fn());
const volumeByGradeQuery = vi.hoisted(() => vi.fn());
const sessionSummaryQuery = vi.hoisted(() => vi.fn());
const recentActivitiesSection = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => null,
}));

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: 90 }),
}));

vi.mock("../../components/ClimbingGradeProgressionChart.tsx", () => ({
  ClimbingGradeProgressionChart: () => <div>Grade Progression component</div>,
}));

vi.mock("../../components/ClimbingVolumeByGradeChart.tsx", () => ({
  ClimbingVolumeByGradeChart: () => <div>Volume by Grade component</div>,
}));

vi.mock("../../components/ClimbingSessionSummaryTable.tsx", () => ({
  ClimbingSessionSummaryTable: (props: { loading?: boolean }) => (
    <div>Recent Climbing Sessions component {String(props.loading)}</div>
  ),
}));

vi.mock("../../components/RecentActivitiesSection.tsx", () => ({
  RecentActivitiesSection: (props: { activityTypes?: readonly string[] }) => {
    recentActivitiesSection(props);
    return <div>Recent Climbing Activities component</div>;
  },
}));

vi.mock("../../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({ error }: { error?: Error | null }) => (
    <div>{error ? `Error: ${error.message}` : "Query state"}</div>
  ),
}));

vi.mock("../../components/ChartDescriptionTooltip.tsx", () => ({
  ChartDescriptionTooltip: () => null,
}));

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    climbing: {
      gradeProgression: { useQuery: gradeProgressionQuery },
      volumeByGrade: { useQuery: volumeByGradeQuery },
      sessionSummary: { useQuery: sessionSummaryQuery },
    },
  },
}));

async function importClimbingTab() {
  const mod = await import("./climbing.tsx");
  return mod.ClimbingTab;
}

describe("ClimbingTab", () => {
  beforeEach(() => {
    gradeProgressionQuery.mockReset();
    volumeByGradeQuery.mockReset();
    sessionSummaryQuery.mockReset();
    recentActivitiesSection.mockReset();
    gradeProgressionQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    volumeByGradeQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    sessionSummaryQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("queries the climbing router and filters recent activities to climbing types", async () => {
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(gradeProgressionQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    expect(volumeByGradeQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    expect(sessionSummaryQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    expect(recentActivitiesSection).toHaveBeenCalledWith({
      activityTypes: ["climbing", "rock_climbing"],
    });
  });

  it("renders the four climbing sections", async () => {
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Grade Progression")).toBeTruthy();
    expect(screen.getByText("Volume by Grade")).toBeTruthy();
    expect(screen.getByText("Recent Climbing Sessions")).toBeTruthy();
    expect(screen.getByText("Recent Climbing Activities")).toBeTruthy();
  });

  it("shows an error only for the failing section", async () => {
    volumeByGradeQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Volume query failed"),
    });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Error: Volume query failed")).toBeTruthy();
    expect(screen.queryByText("Error: Grade query failed")).toBeNull();
    expect(screen.queryByText("Error: Session query failed")).toBeNull();
    expect(screen.getByText("Grade Progression component")).toBeTruthy();
    expect(screen.getByText("Recent Climbing Sessions component false")).toBeTruthy();
  });

  it("shows errors when cached section data is an empty array", async () => {
    gradeProgressionQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Grade query failed"),
    });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Error: Grade query failed")).toBeTruthy();
  });

  it("passes session loading state to the sessions table", async () => {
    sessionSummaryQuery.mockReturnValue({ data: [], isLoading: true, error: null });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Recent Climbing Sessions component true")).toBeTruthy();
  });
});
