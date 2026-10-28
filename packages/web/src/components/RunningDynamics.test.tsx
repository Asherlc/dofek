// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
