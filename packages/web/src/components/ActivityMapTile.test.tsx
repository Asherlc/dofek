/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type ActivityMapLocation, ActivityMapTile } from "./ActivityMapTile.tsx";

const metricUnits = new UnitConverter("metric");

function location(overrides: Partial<ActivityMapLocation> = {}): ActivityMapLocation {
  return {
    tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
    distanceMeters: 5000,
    elevationGainM: 120,
    ...overrides,
  };
}

describe("ActivityMapTile", () => {
  it("replaces failed map tiles with a fallback", () => {
    render(<ActivityMapTile location={location()} units={metricUnits} />);
    fireEvent.error(screen.getByAltText("Activity location map"));

    expect(screen.getByText("Map unavailable")).toBeDefined();
  });

  it("allows map tile requests to include the page origin as the referrer", () => {
    render(<ActivityMapTile location={location()} units={metricUnits} />);

    expect(screen.getByAltText("Activity location map").getAttribute("referrerpolicy")).toBe(
      "origin",
    );
  });

  it("draws a smoothed route overlay when a map tile includes route path points", () => {
    render(
      <ActivityMapTile
        location={location({
          routePath: [
            { x: 27.854, y: 37.951 },
            { x: 29.22, y: 37.088 },
            { x: 30.585, y: 35.936 },
          ],
        })}
        units={metricUnits}
      />,
    );

    expect(screen.getByTestId("activity-route-path").getAttribute("d")).toBe(
      "M 27.854 37.951 C 28.309 37.663, 28.765 37.424, 29.22 37.088 C 29.675 36.752, 30.13 36.32, 30.585 35.936",
    );
  });

  it("keeps the map tile unzoomed so labels stay readable", () => {
    render(
      <ActivityMapTile
        location={location({
          routePath: [
            { x: 5, y: 5 },
            { x: 15, y: 15 },
          ],
        })}
        units={metricUnits}
      />,
    );

    expect(screen.getByTestId("activity-route-viewport").getAttribute("style")).toBeNull();
  });

  it("uses a restrained route stroke over the map tile", () => {
    render(
      <ActivityMapTile
        location={location({
          routePath: [
            { x: 25, y: 30 },
            { x: 35, y: 40 },
          ],
        })}
        units={metricUnits}
      />,
    );

    expect(screen.getByTestId("activity-route-casing").getAttribute("stroke-width")).toBe("4");
    expect(screen.getByTestId("activity-route-path").getAttribute("stroke-width")).toBe("2");
  });
});
