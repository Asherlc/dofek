/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityCardContent, type ActivityCardData } from "./ActivityCardContent.tsx";

const units = new UnitConverter("metric");

function activity(overrides: Partial<ActivityCardData> = {}): ActivityCardData {
  return {
    id: "activity-1",
    name: null,
    activityType: "strength_training",
    startedAt: "2026-07-14T08:46:00.000Z",
    durationMin: 30,
    location: null,
    stats: [{ label: "Training Stress Score", value: "8.5" }],
    ...overrides,
  };
}

afterEach(cleanup);

describe("ActivityCardContent", () => {
  it("uses the same details and route-frame structure for non-map activities", () => {
    render(
      <ActivityCardContent
        activity={activity()}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    const layout = screen.getByTestId("activity-card-layout");
    expect(layout.className).toContain("sm:grid-cols-[minmax(0,2fr)_minmax(18rem,3fr)]");
    expect(screen.getByTestId("activity-detail-metrics")).toBeDefined();
    expect(screen.getByTestId("activity-secondary-panel")).toBeDefined();
    expect(screen.getByTestId("activity-secondary-inset").className).toContain("rounded-lg");
    expect(screen.getByText("Route")).toBeDefined();
    expect(screen.getByText("No route recorded")).toBeDefined();
    expect(screen.getByText("8.5")).toBeDefined();
    expect(screen.getByTestId("activity-type-icon").getAttribute("style")).toBeNull();
  });

  it("gives mapped activities a full-height map pane and keeps metrics with the details", () => {
    render(
      <ActivityCardContent
        activity={activity({
          activityType: "running",
          location: {
            mapPreview: {
              width: 256,
              height: 256,
              tiles: [],
              routePath: null,
            },
            distanceMeters: 5000,
            elevationGainM: 120,
          },
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByLabelText("Activity location map")).toBeDefined();
    expect(screen.getByTestId("activity-detail-metrics")).toBeDefined();
    expect(screen.queryByText("No route recorded")).toBeNull();
    expect(screen.getByTestId("activity-secondary-panel")).toBeDefined();
    expect(screen.getByTestId("activity-secondary-inset").className).toContain("rounded-lg");
    expect(screen.getByText("Route")).toBeDefined();
  });
});
