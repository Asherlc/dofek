// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const chartOptions = vi.hoisted(() => vi.fn());

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    empty,
    emptyMessage,
    loading,
    option,
  }: {
    empty?: boolean;
    emptyMessage?: string;
    loading?: boolean;
    option: Record<string, unknown>;
  }) => {
    chartOptions(option);
    return (
      <div data-testid="chart">
        {loading ? "Loading chart" : empty ? emptyMessage : "volume chart"}
      </div>
    );
  },
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

  it("omits unknown attempts while retaining known sends and recorded zero attempts", () => {
    render(
      <ClimbingVolumeByGradeChart
        data={[
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "VB",
            gradeSortValue: -1,
            attempts: null,
            recordedAttempts: null,
            sends: 1,
          },
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V0",
            gradeSortValue: 0,
            attempts: 0,
            recordedAttempts: 0,
            sends: 0,
          },
        ]}
      />,
    );

    const unknownGrade = screen.getByText("VB").parentElement;
    expect(unknownGrade).toBeTruthy();
    if (!unknownGrade) throw new Error("Missing VB grade card");
    expect(within(unknownGrade).queryByText(/attempt/i)).toBeNull();
    expect(within(unknownGrade).getByText("1 sends")).toBeTruthy();
    expect(screen.getByText("0 attempts")).toBeTruthy();
    expect(screen.getByText("0 sends")).toBeTruthy();
    expect(chartOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: expect.arrayContaining([
          expect.objectContaining({ name: "Recorded attempts", data: [null, 0] }),
        ]),
      }),
    );
  });

  it("renders per-grade sends/attempts ordered by sort value", () => {
    render(
      <ClimbingVolumeByGradeChart
        data={[
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V4",
            gradeSortValue: 4,
            attempts: 3,
            recordedAttempts: 3,
            sends: 2,
          },
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V1",
            gradeSortValue: 1,
            attempts: 5,
            recordedAttempts: 5,
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
    expect(screen.getByText("5 attempts")).toBeTruthy();
    expect(screen.getByText("2 sends")).toBeTruthy();
  });

  it("renders and plots recorded attempts when the complete total is unknown", () => {
    render(
      <ClimbingVolumeByGradeChart
        data={[
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "VB",
            gradeSortValue: -1,
            attempts: null,
            recordedAttempts: 4,
            sends: 1,
          },
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V0",
            gradeSortValue: 0,
            attempts: null,
            recordedAttempts: 0,
            sends: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText("4 recorded attempts")).toBeTruthy();
    expect(screen.getByText("1 sends")).toBeTruthy();
    expect(screen.getByText("0 recorded attempts")).toBeTruthy();
    expect(chartOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: expect.arrayContaining([
          expect.objectContaining({ name: "Recorded attempts", data: [4, 0] }),
        ]),
      }),
    );
  });
});
