// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunningTrainingCard } from "./RunningTrainingCard";
import {
  emptyRunning,
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

  it("keeps the cadence trend and omits the moved per-run form list", () => {
    render(<RunningTrainingCard {...props} />);
    expect(screen.getByLabelText("Running cadence trend, steps per minute")).toBeTruthy();
    expect(screen.queryByText("Running Form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Park Run" })).toBeNull();
  });
  it("shows the server empty cadence state when no observations are available", () => {
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
    expect(screen.getByLabelText("Running cadence trend, steps per minute")).toBeTruthy();
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
  it("shows server-authored empty cadence evidence and a recorded numeric zero", () => {
    const view = render(
      <RunningTrainingCard
        {...props}
        data={{ ...runningData, data: [], cadenceAvailability: emptyRunning }}
      />,
    );
    expect(screen.getByText(emptyRunning.message)).toBeTruthy();
    view.rerender(
      <RunningTrainingCard
        {...props}
        data={{
          ...runningData,
          data: [{ ...intervalRun, cadence: 0, cadenceCoveragePercent: 100 }],
        }}
      />,
    );
    expect(screen.getByLabelText("Running cadence trend, steps per minute")).toBeTruthy();
  });
});

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));

import { captureException } from "../lib/telemetry";

beforeEach(() => vi.mocked(captureException).mockClear());
describe("running response validation", () => {
  it.each([
    null,
    { data: runningData.data, availability: runningData.availability },
    {
      ...runningData,
      cadenceAvailability: { ...runningData.cadenceAvailability, observedCount: -1 },
    },
    { ...runningData, data: [{ ...intervalRun, cadenceBasis: "invalid" }] },
    { ...runningData, data: [{ ...intervalRun, distanceKm: "bad" }] },
  ])("rejects malformed restored data and reports once: %j", (data) => {
    const view = render(
      <RunningTrainingCard
        {...props}
        data={data}
        loading
        error={new Error("Sync intervals first.")}
      />,
    );
    expect(
      screen.getByText(
        "Running data has an unexpected format. Refresh and try again. If it continues, contact support.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Sync intervals first.")).toBeTruthy();
    expect(screen.queryByLabelText("Running cadence trend, steps per minute")).toBeNull();
    expect(captureException).toHaveBeenCalledOnce();
    view.rerender(<RunningTrainingCard {...props} data={data} loading error={null} />);
    expect(captureException).toHaveBeenCalledOnce();
  });
  it("does not report undefined loading as malformed", () => {
    render(<RunningTrainingCard {...props} data={undefined} loading />);
    expect(captureException).not.toHaveBeenCalled();
  });
});
