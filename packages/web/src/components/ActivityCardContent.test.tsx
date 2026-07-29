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
    localTimeContext: {
      timezone: null,
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_offset",
    },
    durationMin: 30,
    location: null,
    stats: [{ status: "available", label: "Training Stress Score", value: "8.5" }],
    ...overrides,
  };
}

afterEach(cleanup);

describe("ActivityCardContent", () => {
  it("renders the stored record-local clock time", () => {
    render(
      <ActivityCardContent
        activity={activity()}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByText(/1:46 AM/)).toBeDefined();
  });

  it("renders a details-only card when no route is available", () => {
    render(
      <ActivityCardContent
        activity={activity()}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByTestId("activity-card-layout")).not.toHaveClass(
      "sm:grid-cols-[minmax(0,2fr)_minmax(18rem,3fr)]",
    );
    expect(screen.getByTestId("activity-detail-metrics")).toBeDefined();
    expect(screen.queryByTestId("activity-secondary-panel")).toBeNull();
    expect(screen.queryByText("Route")).toBeNull();
    expect(screen.queryByText("No route recorded")).toBeNull();
    expect(screen.getByText("8.5")).toBeDefined();
    expect(screen.getByTestId("activity-type-icon").getAttribute("style")).toBeNull();
  });

  it("renders the server-authored unavailable reason instead of a broken dash", () => {
    render(
      <ActivityCardContent
        activity={activity({
          stats: [
            {
              status: "unavailable",
              label: "Training Stress Score",
              reason:
                "Record average power, or record average heart rate and set maximum heart rate.",
            },
          ],
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByText("Training Stress Score unavailable")).toBeDefined();
    expect(
      screen.getByText(
        "Record average power, or record average heart rate and set maximum heart rate.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
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

    expect(screen.getByTestId("activity-card-layout")).toHaveClass(
      "sm:grid-cols-[minmax(0,2fr)_minmax(18rem,3fr)]",
    );
    expect(screen.getByLabelText("Activity location map")).toBeDefined();
    expect(screen.getByTestId("activity-detail-metrics")).toBeDefined();
    expect(screen.queryByText("No route recorded")).toBeNull();
    expect(screen.getByTestId("activity-secondary-panel")).toBeDefined();
    expect(screen.getByTestId("activity-secondary-inset").className).toContain("rounded-lg");
    expect(screen.getByText("Route")).toBeDefined();
  });
});
