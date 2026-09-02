// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    empty,
    emptyMessage,
    loading,
  }: {
    empty?: boolean;
    emptyMessage?: string;
    loading?: boolean;
  }) => (
    <div data-testid="chart">
      {loading ? "Loading chart" : empty ? emptyMessage : "volume chart"}
    </div>
  ),
}));

import { ClimbingVolumeByGradeChart } from "./ClimbingVolumeByGradeChart.tsx";

afterEach(cleanup);

describe("ClimbingVolumeByGradeChart", () => {
  it("renders an empty state when no grade volume rows exist", () => {
    render(<ClimbingVolumeByGradeChart data={[]} />);

    expect(screen.getByText("No climbing volume by grade")).toBeTruthy();
  });

  it("passes loading state to the chart", () => {
    render(<ClimbingVolumeByGradeChart data={[]} loading />);

    expect(screen.getByText("Loading chart")).toBeTruthy();
  });

  it("renders aggregate totals and per-grade sends/attempts ordered by sort value", () => {
    render(
      <ClimbingVolumeByGradeChart
        data={[
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V4",
            gradeSortValue: 4,
            attempts: 3,
            sends: 2,
          },
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V1",
            gradeSortValue: 1,
            attempts: 5,
            sends: 5,
          },
        ]}
      />,
    );

    const gradeOne = screen.getByText("V1");
    const gradeFour = screen.getByText("V4");
    expect(
      gradeOne.compareDocumentPosition(gradeFour) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("8 attempts")).toBeTruthy();
    expect(screen.getByText("7 sends")).toBeTruthy();
    expect(screen.getByText("5 attempts")).toBeTruthy();
    expect(screen.getByText("2 sends")).toBeTruthy();
  });
});
