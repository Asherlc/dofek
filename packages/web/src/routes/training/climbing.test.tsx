/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { climbingProgressionFixture } from "../../components/climbing-progression-test-helpers.ts";
import { climbingStrengthsFixture } from "../../components/climbing-strengths-fixtures.ts";

const gradeProgressionQuery = vi.hoisted(() => vi.fn());
const volumeByGradeQuery = vi.hoisted(() => vi.fn());
const sessionSummaryQuery = vi.hoisted(() => vi.fn());
const hangboardingSummaryQuery = vi.hoisted(() => vi.fn());
const locationMapQuery = vi.hoisted(() => vi.fn());
const strengthsQuery = vi.hoisted(() => vi.fn());
const recentActivitiesSection = vi.hoisted(() => vi.fn());
const trainingDaysState = vi.hoisted<{ days: number | null }>(() => ({ days: 90 }));
const queryDate = vi.hoisted(() => ({ value: "2026-10-26" }));

vi.mock("../../hooks/useTodayQueryDate.ts", () => ({ useTodayQueryDate: () => queryDate.value }));

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

vi.mock("../../components/ClimbingLocationMap.tsx", () => ({
  ClimbingLocationMap: ({ data, loading }: { data?: unknown; loading?: boolean }) => (
    <div>
      {data
        ? "Cached climbing locations"
        : loading
          ? "Loading climbing locations"
          : "Empty climbing locations"}
    </div>
  ),
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

vi.mock("../../components/HangboardingSummary.tsx", () => ({
  HangboardingSummary: () => <div>Hangboarding Summary component</div>,
}));

vi.mock("../../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({ error, variant }: { error?: Error | null; variant?: string }) => (
    <div>
      {error ? `Error: ${error.message}` : variant === "loading" ? "Loading data." : "Query state"}
    </div>
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
      volumeOverTime: {
        useQuery: () => ({ data: [], isLoading: false, isFetching: false, error: null }),
      },
      sessionSummary: { useQuery: sessionSummaryQuery },
      hangboardingSummary: { useQuery: hangboardingSummaryQuery },
      locationMap: { useQuery: locationMapQuery },
      strengths: { useQuery: strengthsQuery },
    },
  },
}));

async function importClimbingTab() {
  const mod = await import("./climbing.tsx");
  return mod.ClimbingTab;
}

describe("ClimbingTab", () => {
  it("anchors the strengths query to today's date and renews its input when the date changes", async () => {
    const ClimbingTab = await importClimbingTab();
    const { rerender } = render(<ClimbingTab />);
    expect(strengthsQuery).toHaveBeenLastCalledWith(
      { days: 90, endDate: "2026-10-26" },
      expect.any(Object),
    );
    queryDate.value = "2026-10-27";
    rerender(<ClimbingTab />);
    expect(strengthsQuery).toHaveBeenLastCalledWith(
      { days: 90, endDate: "2026-10-27" },
      expect.any(Object),
    );
    expect(gradeProgressionQuery).toHaveBeenLastCalledWith({ days: 90 }, expect.any(Object));
  });
  it("retains strengths and shows their refresh error while forwarding filters", async () => {
    strengthsQuery.mockReturnValue({
      data: climbingStrengthsFixture,
      isLoading: false,
      isFetching: true,
      error: new Error("Reconnect strengths provider"),
    });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    expect(screen.getByText("Error: Reconnect strengths provider")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Grades" }));
    expect(screen.getByRole("button", { name: /Vertical · V4/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(strengthsQuery).toHaveBeenLastCalledWith(
      { days: 90, endDate: "2026-10-26", types: ["lead"] },
      expect.any(Object),
    );
  });
  it("shows initial strengths errors without an empty substitute", async () => {
    strengthsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Strengths unavailable"),
    });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    expect(screen.getByText("Error: Strengths unavailable")).toBeVisible();
    expect(screen.queryByText("No recorded climbing strengths in this period.")).toBeNull();
  });
  it("keeps a cached location map above the grade chart while refresh errors remain visible", async () => {
    locationMapQuery.mockReturnValue({
      data: { bounds: null, nodes: [] },
      isLoading: false,
      isFetching: true,
      error: new Error("Reconnect the location provider"),
    });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    const map = screen.getByText("Cached climbing locations");
    const chart = screen.getByText("Grade Progression component");
    expect(map.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Error: Reconnect the location provider")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Updating climbing");
    expect(locationMapQuery).toHaveBeenCalledWith(
      { days: 90 },
      expect.objectContaining({ placeholderData: expect.any(Function) }),
    );
  });

  it("shows initial map errors without an empty-state substitute", async () => {
    locationMapQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Climbing locations unavailable"),
    });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    expect(screen.getByText("Error: Climbing locations unavailable")).toBeVisible();
    expect(screen.queryByText("Empty climbing locations")).toBeNull();
  });
  it("shows actionable refresh errors alongside retained charts", async () => {
    gradeProgressionQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Reconnect the climbing provider"),
    });
    volumeByGradeQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Climbing grade query unavailable"),
    });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    expect(screen.getByText("Grade Progression component")).toBeTruthy();
    expect(screen.getByText("Volume by Grade component")).toBeTruthy();
    expect(screen.getByText("Error: Reconnect the climbing provider")).toBeTruthy();
    expect(screen.getByText("Error: Climbing grade query unavailable")).toBeTruthy();
  });
  it("shows a loading panel while filtered sessions are first fetched", async () => {
    sessionSummaryQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(screen.getByText("Loading data.")).toBeTruthy();
  });
  it("keeps cached session rows visible while a filtered request fails", async () => {
    sessionSummaryQuery.mockReturnValue({
      data: [
        {
          activityId: "cached",
          date: "2026-10-04",
          name: "Cached climbing",
          attempts: 3,
          sends: 2,
          hardestBoulderGrade: null,
          hardestRouteGrade: "5.10a",
        },
      ],
      isLoading: false,
      error: new Error("Climbing query unavailable"),
    });
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(screen.getByRole("link", { name: "Cached climbing" })).toBeTruthy();
    expect(screen.getByText("Error: Climbing query unavailable")).toBeTruthy();
  });
  it("keeps filters collapsed and applies independent selections with removable chips", async () => {
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const toggle = screen.getByRole("button", { name: "More filters" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Protection used" })).toBeNull();
    fireEvent.click(toggle);
    sessionSummaryQuery.mockReturnValue({
      data: [
        {
          activityId: "matched",
          date: "2026-10-04",
          name: "Trad session",
          attempts: 3,
          sends: 2,
          hardestBoulderGrade: null,
          hardestRouteGrade: "5.10a",
        },
      ],
      isLoading: false,
      error: null,
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(screen.getByRole("link", { name: "Trad session" }).getAttribute("href")).toBe(
      "/activity/matched",
    );
    const protection = within(screen.getByRole("group", { name: "Protection used" }));
    fireEvent.click(protection.getByRole("checkbox", { name: "All" }));
    fireEvent.click(protection.getByRole("checkbox", { name: "Trad" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Indoor" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Unknown setting" }));
    expect(volumeByGradeQuery).toHaveBeenLastCalledWith(
      { days: 90, types: ["lead"], protectionUsed: ["trad"], setting: ["outdoor"] },
      expect.any(Object),
    );
    expect(locationMapQuery).toHaveBeenLastCalledWith(
      { days: 90, types: ["lead"], protectionUsed: ["trad"], setting: ["outdoor"] },
      expect.any(Object),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Protection used: Trad filter" }));
    expect(gradeProgressionQuery).toHaveBeenLastCalledWith(
      { days: 90, types: ["lead"], setting: ["outdoor"] },
      expect.any(Object),
    );
  });
  it("preserves explicit false and null solo values in server requests", async () => {
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    const solo = within(screen.getByRole("group", { name: "Solo status" }));
    fireEvent.click(solo.getByRole("checkbox", { name: "All" }));
    fireEvent.click(solo.getByRole("checkbox", { name: "With a belayer" }));
    expect(gradeProgressionQuery).toHaveBeenLastCalledWith(
      { days: 90, types: ["lead"], solo: [false] },
      expect.any(Object),
    );
    fireEvent.click(solo.getByRole("checkbox", { name: "Unknown" }));
    expect(gradeProgressionQuery).toHaveBeenLastCalledWith(
      { days: 90, types: ["lead"], solo: [false, null] },
      expect.any(Object),
    );
    fireEvent.click(solo.getByRole("checkbox", { name: "All" }));
    expect(gradeProgressionQuery).toHaveBeenLastCalledWith(
      { days: 90, types: ["lead"] },
      expect.any(Object),
    );
  });
  beforeEach(() => {
    strengthsQuery.mockReset();
    strengthsQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    gradeProgressionQuery.mockReset();
    volumeByGradeQuery.mockReset();
    sessionSummaryQuery.mockReset();
    hangboardingSummaryQuery.mockReset();
    locationMapQuery.mockReset();
    recentActivitiesSection.mockReset();
    trainingDaysState.days = 90;
    queryDate.value = "2026-10-26";
    gradeProgressionQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    volumeByGradeQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    sessionSummaryQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    hangboardingSummaryQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    locationMapQuery.mockReturnValue({
      data: { bounds: null, nodes: [] },
      isLoading: false,
      error: null,
    });
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
    expect(strengthsQuery).toHaveBeenCalledWith(
      { days: 90, endDate: "2026-10-26" },
      expect.objectContaining({ placeholderData: expect.any(Function) }),
    );
    expect(volumeByGradeQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    expect(sessionSummaryQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    expect(hangboardingSummaryQuery).toHaveBeenCalledWith({ days: 90 }, expect.any(Object));
    const sectionProps = recentActivitiesSection.mock.calls[0]?.[0];
    expect(sectionProps.activityTypes).toEqual(["climbing"]);
    expect(sectionProps.showDistance).toBe(false);
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
    expect(hangboardingSummaryQuery).toHaveBeenCalledWith({}, expect.any(Object));
    expect(locationMapQuery).toHaveBeenCalledWith({}, expect.any(Object));
    expect(strengthsQuery).toHaveBeenCalledWith(
      { days: null, endDate: "2026-10-26" },
      expect.any(Object),
    );
  });

  it("renders one recent climbing table", async () => {
    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Grade Progression")).toBeTruthy();
    expect(screen.getByText("Volume by Grade")).toBeTruthy();
    expect(screen.getByText("Recent Climbing Activities")).toBeTruthy();
    expect(screen.getByText("Hangboarding")).toBeTruthy();
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

    expect(screen.getByText("Error: Grade query failed")).toBeTruthy();
    expect(screen.getByText("Grade Progression component")).toBeTruthy();
  });

  it("keeps stale cached section data visible during refetch errors", async () => {
    gradeProgressionQuery.mockReturnValue({
      data: [climbingProgressionFixture()],
      isLoading: false,
      error: new Error("Grade query failed"),
    });

    const ClimbingTab = await importClimbingTab();
    render(<ClimbingTab />);

    expect(screen.getByText("Error: Grade query failed")).toBeTruthy();
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
