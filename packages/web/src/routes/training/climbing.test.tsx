/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gradeProgressionQuery = vi.hoisted(() => vi.fn());
const volumeByGradeQuery = vi.hoisted(() => vi.fn());
const sessionSummaryQuery = vi.hoisted(() => vi.fn());
const fingerLoadingHistoryQuery = vi.hoisted(() => vi.fn());
const logFingerLoadingMutation = vi.hoisted(() => vi.fn());
const logClimbingSessionMutation = vi.hoisted(() => vi.fn());
const recentActivitiesSection = vi.hoisted(() => vi.fn());
const trainingDaysState = vi.hoisted<{ days: number | null }>(() => ({ days: 90 }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => null,
}));

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => trainingDaysState,
}));

vi.mock("../../components/ClimbingGradeProgressionChart.tsx", () => ({
  ClimbingGradeProgressionChart: () => <div>Grade Progression component</div>,
}));

vi.mock("../../components/ClimbingVolumeByGradeChart.tsx", () => ({
  ClimbingVolumeByGradeChart: () => <div>Volume by Grade component</div>,
}));

vi.mock("../../components/FingerLoadingLog.tsx", () => ({
  FingerLoadingLog: () => <div>Finger Loading form</div>,
}));

vi.mock("../../components/ClimbingAttemptLog.tsx", () => ({
  ClimbingAttemptLog: () => <div>Climbing Attempts form</div>,
}));

vi.mock("../../components/RecentActivitiesSection.tsx", () => ({
  RecentActivitiesSection: (props: {
    activityTypes?: readonly string[];
    additionalColumns?: Array<{
      key: string;
      renderCell: (activity: { id: string }) => React.ReactNode;
    }>;
    additionalDataLoading?: boolean;
  }) => {
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
      fingerLoadingHistory: { useQuery: fingerLoadingHistoryQuery },
      logFingerLoading: { useMutation: logFingerLoadingMutation },
      logClimbingSession: { useMutation: logClimbingSessionMutation },
      volumeByGrade: { useQuery: volumeByGradeQuery },
      sessionSummary: { useQuery: sessionSummaryQuery },
    },
    useUtils: () => ({
      activity: { invalidate: vi.fn() },
      climbing: {
        fingerLoadingHistory: { invalidate: vi.fn() },
        invalidate: vi.fn(),
        sessionSummary: { invalidate: vi.fn() },
      },
      mobileDashboard: { training: { invalidate: vi.fn() } },
    }),
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
    fingerLoadingHistoryQuery.mockReset();
    logFingerLoadingMutation.mockReset();
    logClimbingSessionMutation.mockReset();
    recentActivitiesSection.mockReset();
    trainingDaysState.days = 90;
    gradeProgressionQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    volumeByGradeQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    sessionSummaryQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    fingerLoadingHistoryQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    logFingerLoadingMutation.mockReturnValue({ error: null, isPending: false, mutate: vi.fn() });
    logClimbingSessionMutation.mockReturnValue({ error: null, isPending: false, mutate: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  it("queries the climbing router and adds session metrics to the climbing activity table", async () => {
    sessionSummaryQuery.mockReturnValue({
      data: [
        {
          activityId: "activity-1",
          attempts: 8,
          sends: 7,
          hardestBoulderGrade: "V4",
          hardestRouteGrade: null,
        },
      ],
      isLoading: false,
      error: null,
    });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(gradeProgressionQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    expect(volumeByGradeQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    expect(sessionSummaryQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    const sectionProps = recentActivitiesSection.mock.calls[0]?.[0];
    expect(sectionProps.activityTypes).toEqual(["climbing", "rock_climbing"]);
    expect(sectionProps.additionalColumns.map((column: { key: string }) => column.key)).toEqual([
      "attempts",
      "sends",
      "best-boulder-grade",
      "best-route-grade",
    ]);
    expect(sectionProps.additionalColumns[0].renderCell({ id: "activity-1" })).toBe(8);
    expect(sectionProps.additionalColumns[3].renderCell({ id: "activity-1" })).toBe("None");
  });

  it("omits days when the selected training range is all time", async () => {
    trainingDaysState.days = null;

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(gradeProgressionQuery).toHaveBeenCalledWith({}, expect.any(Object));
    expect(volumeByGradeQuery).toHaveBeenCalledWith({}, expect.any(Object));
    expect(sessionSummaryQuery).toHaveBeenCalledWith({}, expect.any(Object));
  });

  it("renders one recent climbing table", async () => {
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Grade Progression")).toBeTruthy();
    expect(screen.getByText("Volume by Grade")).toBeTruthy();
    expect(screen.getByText("Recent Climbing Activities")).toBeTruthy();
    expect(screen.queryByText("Recent Climbing Sessions")).toBeNull();
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
    expect(screen.getByText("Recent Climbing Activities component")).toBeTruthy();
  });

  it("keeps empty cached section data visible during refetch errors", async () => {
    gradeProgressionQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Grade query failed"),
    });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.queryByText("Error: Grade query failed")).toBeNull();
    expect(screen.getByText("Grade Progression component")).toBeTruthy();
  });

  it("keeps stale cached section data visible during refetch errors", async () => {
    gradeProgressionQuery.mockReturnValue({
      data: [
        {
          date: "2026-07-09",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V4",
          gradeSortValue: 4,
        },
      ],
      isLoading: false,
      error: new Error("Grade query failed"),
    });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.queryByText("Error: Grade query failed")).toBeNull();
    expect(screen.getByText("Grade Progression component")).toBeTruthy();
  });

  it("keeps recent activities visible when session metrics initially fail", async () => {
    sessionSummaryQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Session query failed"),
    });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Error: Session query failed")).toBeTruthy();
    expect(screen.getByText("Recent Climbing Activities component")).toBeTruthy();
    const sectionProps = recentActivitiesSection.mock.calls[0]?.[0];
    expect(sectionProps.additionalColumns[0].renderCell({ id: "activity-1" })).toBe("—");
  });

  it("surfaces session refetch errors while retaining cached metrics", async () => {
    sessionSummaryQuery.mockReturnValue({
      data: [
        {
          activityId: "activity-1",
          attempts: 8,
          sends: 7,
          hardestBoulderGrade: "V4",
          hardestRouteGrade: null,
        },
      ],
      isLoading: false,
      error: new Error("Session refetch failed"),
    });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Error: Session refetch failed")).toBeTruthy();
    expect(screen.getByText("Recent Climbing Activities component")).toBeTruthy();
    const sectionProps = recentActivitiesSection.mock.calls[0]?.[0];
    expect(sectionProps.additionalColumns[0].renderCell({ id: "activity-1" })).toBe(8);
  });

  it("passes session loading state to the unified activities table", async () => {
    sessionSummaryQuery.mockReturnValue({ data: [], isLoading: true, error: null });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(recentActivitiesSection.mock.calls[0]?.[0].additionalDataLoading).toBe(true);
  });
});
