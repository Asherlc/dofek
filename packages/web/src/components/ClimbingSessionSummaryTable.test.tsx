// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

import { ClimbingSessionSummaryTable } from "./ClimbingSessionSummaryTable.tsx";

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
});

describe("ClimbingSessionSummaryTable", () => {
  it("renders an empty state when no sessions exist", () => {
    render(<ClimbingSessionSummaryTable data={[]} />);

    expect(screen.getByText("No climbing sessions")).toBeTruthy();
  });

  it("renders loading before empty state while sessions are loading", () => {
    render(
      <ClimbingSessionSummaryTable
        data={[
          {
            activityId: "activity-1",
            date: "2026-07-09",
            name: "Kaya climbing at Touchstone Pacific Pipe",
            locationName: "Touchstone Pacific Pipe",
            attempts: 8,
            sends: 5,
            hardestBoulderGrade: "V4",
            hardestBoulderGradeSortValue: 4,
            hardestRouteGrade: null,
            hardestRouteGradeSortValue: null,
          },
        ]}
        loading
      />,
    );

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading climbing sessions" })).toBeTruthy();
    expect(screen.queryByText("No climbing sessions")).toBeNull();
    expect(screen.queryByText("Kaya climbing at Touchstone Pacific Pipe")).toBeNull();
  });

  it("renders session location, volume, and hardest grades", () => {
    render(
      <ClimbingSessionSummaryTable
        data={[
          {
            activityId: "activity-1",
            date: "2026-07-09",
            name: "Kaya climbing at Touchstone Pacific Pipe",
            locationName: "Touchstone Pacific Pipe",
            attempts: 8,
            sends: 5,
            hardestBoulderGrade: "V4",
            hardestBoulderGradeSortValue: 4,
            hardestRouteGrade: "5.10a",
            hardestRouteGradeSortValue: 5101,
          },
        ]}
      />,
    );

    expect(screen.getByText("Kaya climbing at Touchstone Pacific Pipe")).toBeTruthy();
    expect(screen.getByText("Touchstone Pacific Pipe")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText("5.10a")).toBeTruthy();
  });

  it("opens the activity detail when a session row is selected", () => {
    render(
      <ClimbingSessionSummaryTable
        data={[
          {
            activityId: "activity-1",
            date: "2026-07-09",
            name: "Kaya climbing at Touchstone Pacific Pipe",
            locationName: "Touchstone Pacific Pipe",
            attempts: 8,
            sends: 5,
            hardestBoulderGrade: "V4",
            hardestBoulderGradeSortValue: 4,
            hardestRouteGrade: null,
            hardestRouteGradeSortValue: null,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("Kaya climbing at Touchstone Pacific Pipe"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/activity/$id",
      params: { id: "activity-1" },
    });
  });
});
