// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { RunningDynamics } from "./RunningDynamics.tsx";
import { emptyRunning, intervalRun, runningData } from "./running-dynamics-test-helpers.ts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./DofekChart.tsx", () => ({ DofekChart: () => <div /> }));
describe("RunningDynamics", () => {
  it("renders supplied basis and coverage with stale data and a specific error", () => {
    render(
      <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
        <RunningDynamics
          data={runningData}
          loading
          error={new Error("Sync running intervals first.")}
        />
      </UnitContext.Provider>,
    );
    expect(screen.getByText("Recorded cadence")).toBeTruthy();
    expect(screen.getByText("Steps · 30% coverage")).toBeTruthy();
    expect(screen.getByText("Sync running intervals first.")).toBeTruthy();
    expect(screen.getByText("Park Run")).toBeTruthy();
  });
  it("retains form-only measurements without fabricated cadence, pace or distance", () => {
    render(
      <RunningDynamics
        data={{
          ...runningData,
          data: [{ ...intervalRun, cadence: null, paceSecondsPerKm: null, distanceKm: null }],
          cadenceAvailability: emptyRunning,
        }}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText(emptyRunning.message)).toBeTruthy();
    expect(screen.getByText("240 ms")).toBeTruthy();
    expect(screen.getAllByText("--").length).toBeGreaterThanOrEqual(3);
  });
});

vi.mock("../lib/telemetry.ts", () => ({ captureException: vi.fn() }));

import { captureException } from "../lib/telemetry.ts";

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
      <RunningDynamics data={data} loading error={new Error("Sync intervals first.")} />,
    );
    expect(
      screen.getByText(
        "Running data has an unexpected format. Refresh and try again. If it continues, contact support.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Sync intervals first.")).toBeTruthy();
    expect(screen.queryByText("Park Run")).toBeNull();
    expect(captureException).toHaveBeenCalledOnce();
    view.rerender(<RunningDynamics data={data} loading error={null} />);
    expect(captureException).toHaveBeenCalledOnce();
  });
  it("does not report undefined loading as malformed", () => {
    render(<RunningDynamics data={undefined} loading error={null} />);
    expect(captureException).not.toHaveBeenCalled();
  });
});
