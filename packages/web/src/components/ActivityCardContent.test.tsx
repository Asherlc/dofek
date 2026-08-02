/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    source: {
      primarySourceLabel: "Strong (via Apple Health)",
      sourceCount: 1,
      overlapSummary: null,
    },
    lastProcessedAt: "2026-07-14T08:50:00.000Z",
    distanceMeters: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
    elevationGainM: null,
    elevationState: { status: "missing", reason: "Elevation not recorded" },
    location: null,
    stats: [{ status: "available", label: "Training Stress Score", value: "8.5" }],
    ...overrides,
  };
}

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

describe("ActivityCardContent", () => {
  it("renders server-authored source overlap and processing freshness", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));

    render(
      <ActivityCardContent
        activity={activity({
          source: {
            primarySourceLabel: "Wahoo",
            sourceCount: 2,
            overlapSummary: "2 matched source records · Wahoo selected by source priority",
          },
          lastProcessedAt: "2026-07-14T08:59:00.000Z",
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByText("Wahoo")).toBeDefined();
    expect(
      screen.getByText("2 matched source records · Wahoo selected by source priority"),
    ).toBeDefined();
    expect(screen.getByText("Processed 1m ago")).toBeDefined();
  });

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
              status: "missing",
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
          distanceMeters: 5000,
          distanceState: { status: "available" },
          elevationGainM: 120,
          elevationState: { status: "available" },
          location: {
            mapPreview: {
              width: 256,
              height: 256,
              tiles: [],
              routePath: null,
            },
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

  it("does not present missing route measurements as available dashes", () => {
    render(
      <ActivityCardContent
        activity={activity({
          activityType: "running",
          distanceMeters: null,
          distanceState: { status: "missing", reason: "Distance not recorded" },
          elevationGainM: null,
          elevationState: { status: "missing", reason: "Elevation not recorded" },
          location: {
            mapPreview: {
              width: 256,
              height: 256,
              tiles: [],
              routePath: null,
            },
          },
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByText("Distance unavailable")).toBeDefined();
    expect(screen.getByText("Elevation unavailable")).toBeDefined();
    expect(screen.getByText("Distance not recorded")).toBeDefined();
    expect(screen.getByText("Elevation not recorded")).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
  });

  it.each([
    "stale",
    "failed",
    "processing",
    "conflicting",
  ] as const)("renders a distinct %s server-authored state", (status) => {
    render(
      <ActivityCardContent
        activity={activity({
          stats: [{ status, label: "Training Stress Score", reason: "Sync the source and retry." }],
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByText(`Training Stress Score ${status}`)).toBeDefined();
    expect(screen.getByText("Sync the source and retry.")).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
  });
});
