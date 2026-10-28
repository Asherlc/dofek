/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import type { RouteComparison } from "@dofek/training/route-comparison";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { ActivityComparisonChart } from "./ActivityComparisonChart.tsx";

interface ChartOption {
  xAxis: { type: string; show: boolean; axisLabel: { formatter: (value: number) => string } };
  yAxis: { inverse: boolean; scale: boolean };
  series: Array<{ type: string; data: Array<{ id: string; value: [string, number] }> }>;
  tooltip: { formatter: (params: { dataIndex: number }) => string };
}

let capturedOption: ChartOption | null = null;
vi.mock("echarts-for-react", () => ({
  default: (props: { option: ChartOption }) => {
    capturedOption = props.option;
    return <div />;
  },
}));

function option(): ChartOption {
  if (!capturedOption) throw new Error("Expected a rendered chart option");
  return capturedOption;
}

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOption = null;
  const wrap = (children: ReactNode) => (
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {children}
    </UnitContext.Provider>
  );
  const result = render(wrap(ui));
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

const park: RouteComparison = {
  routeId: "00000000-0000-4000-8000-000000000001",
  activityName: "Hiking",
  activityType: "hiking",
  attemptCount: 7,
  instances: [
    {
      activityId: "00000000-0000-4000-8000-000000000011",
      activityName: "Morning park loop",
      date: "2026-03-10",
      startedAt: "2026-03-10T08:00:00Z",
      distanceKm: 5,
      averagePaceMinPerKm: 5,
      durationMinutes: 25,
      avgHeartRate: 150,
      elevationGainMeters: 50,
    },
    {
      activityId: "00000000-0000-4000-8000-000000000012",
      activityName: "Evening park loop",
      date: "2026-03-10",
      startedAt: "2026-03-10T18:00:00Z",
      distanceKm: 5,
      averagePaceMinPerKm: 4.8,
      durationMinutes: 24,
      avgHeartRate: 148,
      elevationGainMeters: 50,
    },
  ],
};
const river: RouteComparison = {
  ...park,
  routeId: "00000000-0000-4000-8000-000000000002",
  activityName: "Hiking",
  attemptCount: 2,
  instances: park.instances.map((instance) => ({
    ...instance,
    activityId: instance.activityId.replace("001", "002"),
    activityName: "River trail",
    distanceKm: 12,
    averagePaceMinPerKm: 7,
  })),
};

describe("ActivityComparisonChart", () => {
  it("selects one matched route with distinguishing labels and the server's attempt count", () => {
    renderWithUnits(<ActivityComparisonChart data={[park, river]} />);
    const picker = screen.getByRole("combobox", { name: "Route" });
    const choices = within(picker).getAllByRole("option");
    expect(choices[0]).toHaveTextContent(/Hiking.*5.00 km.*7 attempts/);
    expect(choices[1]).toHaveTextContent(/Hiking.*12.00 km.*2 attempts/);
    expect(choices[0]?.textContent).not.toBe(choices[1]?.textContent);
    expect(option().series).toHaveLength(1);
    expect(option().series[0]?.data[0]?.value[1]).toBe(300);

    fireEvent.change(picker, { target: { value: river.routeId } });
    expect(option().series).toHaveLength(1);
    expect(option().series[0]?.data[0]?.value[1]).toBe(420);
    expect(screen.getByText("View attempts (2)")).toBeTruthy();
  });

  it("plots same-day attempts by full start timestamp with a visible date axis and faster at the top", () => {
    renderWithUnits(<ActivityComparisonChart data={[park]} />);
    expect(option().series[0]?.type).toBe("scatter");
    expect(option().series[0]?.data).toEqual([
      { id: park.instances[0]?.activityId, value: ["2026-03-10T08:00:00Z", 300] },
      { id: park.instances[1]?.activityId, value: ["2026-03-10T18:00:00Z", 288] },
    ]);
    expect(option().xAxis.type).toBe("time");
    expect(option().xAxis.show).toBe(true);
    expect(option().xAxis.axisLabel.formatter(Date.UTC(2026, 2, 10, 12))).toContain("2026");
    expect(option().xAxis.axisLabel.formatter(Date.UTC(2026, 2, 10, 8))).not.toBe(
      option().xAxis.axisLabel.formatter(Date.UTC(2026, 2, 10, 18)),
    );
    expect(option().yAxis).toMatchObject({ inverse: true, scale: true });
    expect(screen.getByText(/Pace \(min\/km\)/)).toBeVisible();
    expect(screen.getByText(/Faster pace is higher/)).toBeTruthy();
  });

  it("keeps missing pace out of the scatter and retains that attempt with an activity link", () => {
    const missingPace = {
      ...park,
      instances: park.instances.map((instance, index) =>
        index === 1 ? { ...instance, averagePaceMinPerKm: null, distanceKm: null } : instance,
      ),
    };
    renderWithUnits(<ActivityComparisonChart data={[missingPace]} />);
    expect(option().series[0]?.data).toEqual([
      { id: park.instances[0]?.activityId, value: ["2026-03-10T08:00:00Z", 300] },
    ]);
    fireEvent.click(screen.getByText("View attempts (7)"));
    expect(screen.getByText("Pace unavailable")).toBeVisible();
    const link = screen.getByRole("link", { name: /Evening park loop/ });
    expect(link).toHaveAttribute("href", `/activity/${park.instances[1]?.activityId}`);
    expect(
      within(link.closest("tr") ?? document.body).getByText("Distance unavailable"),
    ).toBeVisible();
    expect(screen.getByText("5:00 /km")).toBeVisible();
  });

  it("offers exact attempts even when none has pace", () => {
    const noPace = {
      ...park,
      instances: park.instances.map((instance) => ({ ...instance, averagePaceMinPerKm: null })),
    };
    renderWithUnits(<ActivityComparisonChart data={[noPace]} />);
    expect(screen.getByText(/No pace available for this route/)).toBeVisible();
    fireEvent.click(screen.getByText("View attempts (7)"));
    expect(screen.getAllByText("Pace unavailable")).toHaveLength(2);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("preserves the selected route on refresh and reconciles removal to a surviving route", () => {
    const { rerender } = renderWithUnits(<ActivityComparisonChart data={[park, river]} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: river.routeId } });
    rerender(<ActivityComparisonChart data={[{ ...park }, { ...river }]} loading />);
    expect(screen.getByRole("combobox")).toHaveValue(river.routeId);
    expect(option().series[0]?.data[0]?.value[1]).toBe(420);

    rerender(<ActivityComparisonChart data={[park]} />);
    expect(screen.getByRole("combobox")).toHaveValue(park.routeId);
    expect(option().series[0]?.data[0]?.value[1]).toBe(300);
    rerender(<ActivityComparisonChart data={[river, park]} />);
    expect(screen.getByRole("combobox")).toHaveValue(park.routeId);
  });

  it("retains the initial route when the first refresh reorders routes", () => {
    const { rerender } = renderWithUnits(<ActivityComparisonChart data={[park, river]} />);
    rerender(<ActivityComparisonChart data={[river, park]} />);
    expect(screen.getByRole("combobox")).toHaveValue(park.routeId);
    expect(option().series[0]?.data[0]?.value[1]).toBe(300);
  });

  it("follows a selected route's new anchor and remembers it for later refreshes", () => {
    const oldAnchor = "00000000-0000-4000-8000-000000000020";
    const newAnchor = "00000000-0000-4000-8000-000000000010";
    const selectedRoute = {
      ...river,
      routeId: oldAnchor,
      instances: river.instances.map((attempt, index) => ({
        ...attempt,
        activityId: index === 0 ? oldAnchor : "00000000-0000-4000-8000-000000000030",
      })),
    };
    const firstAttempt = selectedRoute.instances[0];
    if (!firstAttempt) throw new Error("Expected route fixture");
    const refreshed = {
      ...selectedRoute,
      routeId: newAnchor,
      attemptCount: 3,
      instances: [{ ...firstAttempt, activityId: newAnchor }, ...selectedRoute.instances],
    };
    const { rerender } = renderWithUnits(<ActivityComparisonChart data={[park, selectedRoute]} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: oldAnchor } });
    rerender(<ActivityComparisonChart data={[park, refreshed]} />);
    expect(screen.getByRole("combobox")).toHaveValue(newAnchor);
    expect(option().series[0]?.data).toHaveLength(3);
    rerender(
      <ActivityComparisonChart
        data={[
          park,
          {
            ...refreshed,
            attemptCount: 2,
            instances: refreshed.instances.filter((attempt) => attempt.activityId !== oldAnchor),
          },
        ]}
      />,
    );
    expect(screen.getByRole("combobox")).toHaveValue(newAnchor);
    expect(option().series[0]?.data[0]?.value[1]).toBe(420);
  });

  it("converts pace and distance consistently for imperial chart and exact values", () => {
    renderWithUnits(<ActivityComparisonChart data={[park]} />, "imperial");
    expect(screen.getByText(/Pace \(min\/mi\)/)).toBeVisible();
    expect(option().series[0]?.data[0]?.value[1]).toBeCloseTo(482.8032);
    fireEvent.click(screen.getByText("View attempts (7)"));
    expect(screen.getByText("8:03 /mi")).toBeVisible();
    expect(screen.getAllByText("3.11 mi")).toHaveLength(2);
    const tooltip = option().tooltip.formatter({ dataIndex: 0 });
    expect(tooltip).toContain("8:03 /mi");
    expect(tooltip).toContain("3.11 mi");
  });

  it("escapes activity and route names in the tooltip and identifies the exact attempt", () => {
    renderWithUnits(
      <ActivityComparisonChart
        data={[
          {
            ...park,
            activityName: '<img src="route">',
            instances: park.instances.map((instance) => ({
              ...instance,
              activityName: '<script>alert("attempt")</script>',
            })),
          },
        ]}
      />,
    );
    const tooltip = option().tooltip.formatter({ dataIndex: 0 });
    expect(tooltip).toContain("&lt;script&gt;");
    expect(tooltip).not.toContain("<script>");
    expect(tooltip).toContain("2026");
    expect(tooltip).toContain("5:00 /km");
  });

  it("retains distinct initial loading and GPS-matched empty states", () => {
    const { container, rerender } = renderWithUnits(<ActivityComparisonChart data={[]} loading />);
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    rerender(<ActivityComparisonChart data={[]} />);
    expect(screen.getByText(/No repeated GPS-matched routes/)).toBeVisible();
  });
});
