import { UnitConverter } from "@dofek/format/units";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityMetricStrip } from "./ActivityMetricStrip";

const units = new UnitConverter("metric");

describe("ActivityMetricStrip", () => {
  it("renders a server-authored unavailable reason instead of a broken dash", () => {
    render(
      <ActivityMetricStrip
        activity={{
          location: null,
          distanceMeters: null,
          distanceState: { status: "missing", reason: "Distance not recorded" },
          elevationGainM: null,
          elevationState: { status: "missing", reason: "Elevation not recorded" },
          stats: [
            {
              status: "missing",
              label: "Training Stress Score",
              reason:
                "Record average power, or record average heart rate and set maximum heart rate.",
            },
          ],
        }}
        units={units}
      />,
    );

    expect(
      screen.getByLabelText(
        "Training Stress Score unavailable: Record average power, or record average heart rate and set maximum heart rate.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Training Stress Score unavailable")).toBeDefined();
    expect(
      screen.getByText(
        "Record average power, or record average heart rate and set maximum heart rate.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("renders available server-authored stats", () => {
    render(
      <ActivityMetricStrip
        activity={{
          location: null,
          distanceMeters: null,
          distanceState: { status: "missing", reason: "Distance not recorded" },
          elevationGainM: null,
          elevationState: { status: "missing", reason: "Elevation not recorded" },
          stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
        }}
        units={units}
      />,
    );

    expect(screen.getByText("Training Stress Score")).toBeDefined();
    expect(screen.getByText("100")).toBeDefined();
  });

  it("renders map metrics instead of activity stats when location is available", () => {
    render(
      <ActivityMetricStrip
        activity={{
          location: {
            mapPreview: {},
          },
          distanceMeters: 10_000,
          distanceState: { status: "available" },
          elevationGainM: 250,
          elevationState: { status: "available" },
          stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
        }}
        units={units}
      />,
    );

    expect(screen.getByText("10.0 km")).toBeDefined();
    expect(screen.getByText("250 m")).toBeDefined();
    expect(screen.queryByText("Training Stress Score")).toBeNull();
  });

  it("does not present missing route measurements as available dashes", () => {
    render(
      <ActivityMetricStrip
        activity={{
          location: {
            mapPreview: {},
          },
          distanceMeters: null,
          distanceState: { status: "missing", reason: "Distance not recorded" },
          elevationGainM: null,
          elevationState: { status: "missing", reason: "Elevation not recorded" },
          stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
        }}
        units={units}
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
      <ActivityMetricStrip
        activity={{
          location: null,
          distanceMeters: null,
          distanceState: { status: "missing", reason: "Distance not recorded" },
          elevationGainM: null,
          elevationState: { status: "missing", reason: "Elevation not recorded" },
          stats: [{ status, label: "Training Stress Score", reason: "Sync the source and retry." }],
        }}
        units={units}
      />,
    );

    expect(screen.getByText(`Training Stress Score ${status}`)).toBeDefined();
    expect(screen.getByText("Sync the source and retry.")).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
  });
});
