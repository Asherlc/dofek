// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunningTrainingCard } from "./RunningTrainingCard";
import {
  emptyRunning,
  emptyRunningForm,
  intervalRun,
  recordedRun,
  runningData,
} from "./running-training-test-helpers";

// Give the real chart its measured layout; preserve all rendering behavior.
vi.mock("./charts/SparkLine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./charts/SparkLine")>();
  return {
    SparkLine: (props: Parameters<typeof actual.SparkLine>[0]) => (
      <actual.SparkLine {...props} width={140} height={100} />
    ),
  };
});
const props = {
  data: runningData,
  loading: false,
  error: null,
  units: new UnitConverter("metric"),
  onOpenActivity: vi.fn(),
};
describe("RunningTrainingCard", () => {
  it.each([
    { data: [intervalRun], count: 1 },
    {
      data: [recordedRun, { ...recordedRun, activityId: "form-only", cadence: null }, intervalRun],
      count: 2,
    },
    { data: [{ ...intervalRun, cadence: 0 }], count: 1 },
  ])("renders $count available cadence observations in the chart", ({ data, count }) => {
    const { container } = render(
      <RunningTrainingCard
        {...props}
        data={{
          ...runningData,
          data,
          cadenceAvailability: { ...runningData.cadenceAvailability, observedCount: count },
        }}
      />,
    );
    expect(container.querySelectorAll("circle")).toHaveLength(count);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
  });

  it("renders server cadence basis and coverage and opens the source run", () => {
    render(<RunningTrainingCard {...props} />);
    expect(screen.getByText("Recorded cadence")).toBeTruthy();
    expect(screen.getByText("Steps · 30% coverage")).toBeTruthy();
    expect(screen.getAllByText("200 spm").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Open Park Run" }));
    expect(props.onOpenActivity).toHaveBeenCalledWith("run-2");
  });
  it("retains form measurements with missing cadence, pace, distance and optional dynamics", () => {
    render(
      <RunningTrainingCard
        {...props}
        data={{
          ...runningData,
          data: [{ ...intervalRun, cadence: null, paceSecondsPerKm: null, distanceKm: null }],
          cadenceAvailability: emptyRunning,
        }}
      />,
    );
    expect(screen.getByText(emptyRunning.message)).toBeTruthy();
    expect(screen.getByText("Ground contact 240 ms")).toBeTruthy();
    expect(screen.getByText("Cadence —")).toBeTruthy();
    expect(screen.getByText("Pace —")).toBeTruthy();
    expect(screen.getByText("Distance —")).toBeTruthy();
    expect(screen.getByText("Stride —")).toBeTruthy();
  });
  it("keeps data and specific errors visible during refetch and offers retry", () => {
    const retry = vi.fn();
    render(
      <RunningTrainingCard
        {...props}
        loading
        error={new Error("Sync running intervals first.")}
        onRetry={retry}
      />,
    );
    expect(screen.getByText("Sync running intervals first.")).toBeTruthy();
    expect(screen.getByText("Park Run")).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it("shows initial loading and initial error states", () => {
    const view = render(<RunningTrainingCard {...props} data={undefined} loading />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    view.rerender(
      <RunningTrainingCard
        {...props}
        data={undefined}
        error={new Error("Activity analytics unavailable. Retry sync.")}
      />,
    );
    expect(screen.getByText("Activity analytics unavailable. Retry sync.")).toBeTruthy();
  });
  it("shows server-authored empty evidence and recorded numeric zero", () => {
    const view = render(
      <RunningTrainingCard
        {...props}
        data={{
          ...runningData,
          data: [],
          availability: emptyRunningForm,
          cadenceAvailability: emptyRunning,
        }}
      />,
    );
    expect(screen.getByText(emptyRunning.message)).toBeTruthy();
    expect(screen.getByText(emptyRunningForm.message)).toBeTruthy();
    view.rerender(
      <RunningTrainingCard
        {...props}
        data={{
          ...runningData,
          data: [{ ...intervalRun, cadence: 0, cadenceCoveragePercent: 100 }],
        }}
      />,
    );
    expect(screen.getAllByText("0 spm").length).toBeGreaterThan(0);
    expect(screen.getByText("Steps · 100% coverage")).toBeTruthy();
  });
});
