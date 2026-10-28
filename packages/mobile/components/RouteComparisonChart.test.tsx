// @vitest-environment jsdom
import { formatDateMedium, formatDateTime, formatTimeOnly } from "@dofek/format/format";
import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RouteComparisonChart } from "./RouteComparisonChart";
import { routeComparisonFixture } from "./route-comparison-fixtures";

afterEach(cleanup);
const units = new UnitConverter("metric");

it("plots same-day attempts separately using timestamps and labels pace direction", () => {
  const { container } = render(
    <RouteComparisonChart
      routes={routeComparisonFixture}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  const points = container.querySelectorAll("circle");
  expect(points).toHaveLength(2);
  expect(points[0]?.getAttribute("cx")).not.toBe(points[1]?.getAttribute("cx"));
  expect(Number(points[1]?.getAttribute("cy"))).toBeLessThan(Number(points[0]?.getAttribute("cy")));
  expect(screen.getByText("Pace (min/km) · Faster ↑")).toBeTruthy();
  expect(screen.getByText("Activity date")).toBeTruthy();
});

it("shows exact server values, unavailable pace, and opens the selected attempt", () => {
  const open = vi.fn();
  render(
    <RouteComparisonChart
      routes={routeComparisonFixture}
      units={units}
      width={360}
      onActivityPress={open}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "View Route comparison data" }));
  const row = screen.getByRole("button", {
    name: /Morning river run:.*5:00 \/km.*25m.*5.0 km.*140 bpm.*20 m/,
  });
  expect(row.textContent).toContain(formatDateTime("2026-10-20T08:00:00.000Z"));
  fireEvent.click(row);
  expect(open).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  expect(
    screen.getByRole("button", {
      name: /River run without distance:.*Pace unavailable.*Distance unavailable/,
    }),
  ).toBeTruthy();
});

it("selects by stable route ID across reordered refreshes and falls back when removed", () => {
  const { rerender, container } = render(
    <RouteComparisonChart
      routes={routeComparisonFixture}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: /Forest trail · Hiking · .* · 2 attempts/ }));
  expect(container.querySelectorAll("circle")).toHaveLength(2);
  rerender(
    <RouteComparisonChart
      routes={[...routeComparisonFixture].reverse()}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole("radio", { name: /Forest trail · Hiking · .* · 2 attempts/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  rerender(
    <RouteComparisonChart
      routes={routeComparisonFixture.slice(0, 1)}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole("radio", { name: /River loop · Running · .* · 3 attempts/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  rerender(
    <RouteComparisonChart
      routes={[...routeComparisonFixture].reverse()}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole("radio", { name: /River loop · Running · .* · 3 attempts/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

it("retains the initial route when the first refresh reorders routes", () => {
  const { rerender } = render(
    <RouteComparisonChart
      routes={routeComparisonFixture}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  rerender(
    <RouteComparisonChart
      routes={[...routeComparisonFixture].reverse()}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /River loop/ }).getAttribute("aria-checked")).toBe(
    "true",
  );
});

it("follows a selected route's new anchor and remembers it for later refreshes", () => {
  const [river, forest] = routeComparisonFixture;
  if (!river || !forest?.instances[0]) throw new Error("Expected route fixtures");
  const oldAnchor = forest.instances[0].activityId;
  const newAnchor = "55555555-5555-4555-8555-555555555555";
  const selectedRoute = { ...forest, routeId: oldAnchor };
  const refreshed = {
    ...forest,
    routeId: newAnchor,
    attemptCount: 3,
    instances: [{ ...forest.instances[0], activityId: newAnchor }, ...forest.instances],
  };
  const { rerender, container } = render(
    <RouteComparisonChart
      routes={[river, selectedRoute]}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: /Forest trail/ }));
  rerender(
    <RouteComparisonChart
      routes={[river, refreshed]}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Forest trail/ }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(container.querySelectorAll("circle")).toHaveLength(3);
  rerender(
    <RouteComparisonChart
      routes={[
        river,
        {
          ...refreshed,
          attemptCount: 2,
          instances: refreshed.instances.filter((attempt) => attempt.activityId !== oldAnchor),
        },
      ]}
      units={units}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Forest trail/ }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(container.querySelectorAll("circle")).toHaveLength(2);
});

it("converts pace to imperial units and keeps unavailable attempts in the data rows", () => {
  render(
    <RouteComparisonChart
      routes={routeComparisonFixture}
      units={new UnitConverter("imperial")}
      width={360}
      onActivityPress={vi.fn()}
    />,
  );
  expect(screen.getByText("Pace (min/mi) · Faster ↑")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View Route comparison data" }));
  expect(screen.getByRole("button", { name: /Morning river run:.*8:03 \/mi/ })).toBeTruthy();
});

it("keeps all attempts available when none has a recorded pace", () => {
  const routes = routeComparisonFixture.map((route) => ({
    ...route,
    instances: route.instances.map((instance) => ({ ...instance, averagePaceMinPerKm: null })),
  }));
  render(
    <RouteComparisonChart routes={routes} units={units} width={360} onActivityPress={vi.fn()} />,
  );
  expect(screen.getByText("Pace unavailable for these attempts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View Route comparison data" }));
  expect(screen.getAllByRole("button", { name: /:.*Pace unavailable/ })).toHaveLength(3);
});

it("centers simultaneous attempts and renders equal paces with finite coordinates", () => {
  const routes = routeComparisonFixture.map((route) => ({
    ...route,
    instances: route.instances.map((instance) => ({
      ...instance,
      startedAt: "2026-10-20T08:00:00.000Z",
      averagePaceMinPerKm: 5,
    })),
  }));
  const { container } = render(
    <RouteComparisonChart routes={routes} units={units} width={360} onActivityPress={vi.fn()} />,
  );
  const points = container.querySelectorAll("circle");
  expect(points).toHaveLength(3);
  for (const point of points) {
    expect(Number(point.getAttribute("cx"))).toBe(191);
    expect(Number(point.getAttribute("cy"))).toBe(106);
  }
});

it.each([new UnitConverter("metric"), new UnitConverter("imperial")])(
  "distinguishes matching route titles by distance and local start date in $system units",
  (displayUnits) => {
    const routes = routeComparisonFixture.map((route) => ({
      ...route,
      activityName: "Running",
      activityType: "running",
      attemptCount: 3,
    }));
    const open = vi.fn();
    render(
      <RouteComparisonChart
        routes={routes}
        units={displayUnits}
        width={360}
        onActivityPress={open}
      />,
    );
    const firstLabel = `Running · Running · ${displayUnits.formatDistance(5).text} · ${formatDateMedium("2026-10-20T08:00:00.000Z")} · 3 attempts`;
    const secondLabel = `Running · Running · ${displayUnits.formatDistance(4).text} · ${formatDateMedium("2026-10-21T08:00:00.000Z")} · 3 attempts`;
    expect(screen.getByRole("radio", { name: firstLabel })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: secondLabel }));
    fireEvent.click(screen.getByRole("button", { name: "View Route comparison data" }));
    fireEvent.click(screen.getByRole("button", { name: /Forest morning:/ }));
    expect(open).toHaveBeenCalledWith("66666666-6666-4666-8666-666666666666");
  },
);

it("includes years for observations from different years", () => {
  const routes = routeComparisonFixture.map((route) => ({
    ...route,
    instances: route.instances.map((instance, index) => ({
      ...instance,
      startedAt: index === 0 ? "2025-10-20T08:00:00.000Z" : instance.startedAt,
    })),
  }));
  const { container } = render(
    <RouteComparisonChart routes={routes} units={units} width={360} onActivityPress={vi.fn()} />,
  );
  const ticks = [...container.querySelectorAll("svgtext")].map((label) => label.textContent);
  expect(ticks).toContain(formatDateMedium("2025-10-20T08:00:00.000Z"));
  expect(ticks).toContain(formatDateMedium("2026-10-27T08:00:00.000Z"));
});

it("uses time ticks with a local calendar date when endpoints fall on the same day", () => {
  const routes = routeComparisonFixture.map((route) => ({
    ...route,
    instances: route.instances.slice(0, 2),
  }));
  const { container } = render(
    <RouteComparisonChart routes={routes} units={units} width={360} onActivityPress={vi.fn()} />,
  );
  const ticks = [...container.querySelectorAll("svgtext")].map((label) => label.textContent);
  expect(ticks).toContain(formatTimeOnly("2026-10-20T08:00:00.000Z"));
  expect(ticks).toContain(formatTimeOnly("2026-10-20T18:00:00.000Z"));
  expect(
    screen.getByText(`Activity date · ${formatDateMedium("2026-10-20T08:00:00.000Z")}`),
  ).toBeTruthy();
});
