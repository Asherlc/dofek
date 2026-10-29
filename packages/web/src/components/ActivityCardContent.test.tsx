/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maps, resetMaps } from "../lib/maplibre-test-helpers.ts";
import { ActivityCardContent, type ActivityCardData } from "./ActivityCardContent.tsx";

vi.mock("maplibre-gl", async () => (await import("../lib/maplibre-test-helpers.ts")).maplibreMock);

beforeEach(() => {
  resetMaps();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(512);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(288);
});

async function finishMapSnapshot() {
  await waitFor(() => expect(maps.length).toBeGreaterThan(0));
  act(() => {
    for (const map of maps) map.fire("idle");
  });
}

const units = new UnitConverter("metric");

function activity(overrides: Partial<ActivityCardData> = {}): ActivityCardData {
  return {
    id: "activity-1",
    name: null,
    activityType: "strength",
    primaryActivityType: null,
    modality: null,
    startedAt: "2026-07-14T08:46:00.000Z",
    localTimeContext: {
      timezone: null,
      startUtcOffsetMinutes: -420,
      endUtcOffsetMinutes: -420,
      source: "provider_offset",
    },
    durationMin: 30,
    source: {
      origin: { status: "unresolved", candidateMemberActivityIds: [] },
      tree: { primary: null, otherSources: [] },
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

describe("ActivityCardContent", () => {
  it("uses the primary activity type for an unnamed activity title and selection label", () => {
    render(
      <ActivityCardContent
        activity={activity({ activityType: "walking", primaryActivityType: "running" })}
        units={units}
        selectMode
        selected={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Running" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Select Running" })).toBeDefined();
  });

  const photo = {
    id: "photo-1",
    url: "https://private.test/photo",
    width: 1200,
    height: 800,
    mimeType: "image/jpeg",
    sizeBytes: 12000,
    sources: [],
  };

  it("shows one photo in the secondary panel when the activity has no map", () => {
    render(
      <ActivityCardContent
        activity={activity()}
        units={units}
        selectMode={false}
        selected={false}
        photo={photo}
      />,
    );
    expect(screen.getByRole("img", { name: "Activity photo" })).toHaveAttribute("src", photo.url);
    expect(screen.getByTestId("activity-card-layout")).toHaveClass(
      "sm:grid-cols-[minmax(0,2fr)_minmax(18rem,3fr)]",
    );
    expect(screen.getByTestId("activity-secondary-panel")).toBeInTheDocument();
  });

  it("directs users to activity details when a card photo fails", () => {
    render(
      <ActivityCardContent
        activity={activity()}
        units={units}
        selectMode={false}
        selected={false}
        photo={photo}
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Activity photo" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Open the activity to refresh photos");
  });

  it.each([
    { kind: "processing" as const },
    {
      kind: "recorded_gps" as const,
      centroidLat: 37,
      centroidLng: -122,
      mapPreview: {
        width: 512,
        height: 288,
        center: [0, 0] satisfies [number, number],
        zoom: 0,
        routePath: null,
      },
    },
  ])("keeps the $kind map instead of a photo", (location) => {
    render(
      <ActivityCardContent
        activity={activity({ location })}
        units={units}
        selectMode={false}
        selected={false}
        photo={photo}
      />,
    );
    expect(screen.queryByRole("img", { name: "Activity photo" })).toBeNull();
    expect(screen.getByTestId("activity-secondary-panel")).toBeInTheDocument();
  });

  it.each(["garmin", "strava", "apple_health"])(
    "keeps the activity icon ahead of the resolved %s source control",
    (providerId) => {
      render(
        <ActivityCardContent
          activity={activity({
            source: {
              origin: {
                status: "resolved",
                memberActivityId: "00000000-0000-4000-8000-000000000001",
                providerId,
                sourceName: providerId === "apple_health" ? "Strong" : "Garmin Edge 530",
              },
              tree: {
                primary: {
                  id: "source-1",
                  providerId: providerId === "apple_health" ? "strong-csv" : providerId,
                  sourceName: providerId === "garmin" ? "Garmin Edge 530" : null,
                  label: providerId,
                  description: null,
                  url: null,
                  children: [],
                },
                otherSources: [],
              },
              primarySourceLabel: providerId,
              sourceCount: 2,
              overlapSummary: "2 matched source records",
            },
          })}
          units={units}
          selectMode={false}
          selected={false}
        />,
      );
      const activityIcon = screen.getByTestId("activity-type-icon");
      expect(activityIcon.parentElement?.firstElementChild).toBe(activityIcon);
      const source = screen.getByRole("button", { name: /Sources/ });
      const logo = source.querySelector("img");
      expect(logo).toHaveAttribute("width", "18");
      expect(logo?.getAttribute("src")).toContain(
        providerId === "garmin"
          ? "010-02060-00"
          : providerId === "apple_health"
            ? "strong-csv"
            : providerId,
      );
    },
  );

  it("keeps activity content when no external source records are available", () => {
    render(
      <ActivityCardContent
        activity={activity({
          source: {
            origin: { status: "unresolved", candidateMemberActivityIds: [] },
            tree: { primary: null, otherSources: [] },
            primarySourceLabel: null,
            sourceCount: 1,
            overlapSummary: null,
          },
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );
    expect(screen.getByTestId("activity-type-icon")).toBeVisible();
    expect(screen.getByText("Training Stress Score")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sources" })).toBeNull();
  });
  it.each([
    { modality: "indoor", distanceMeters: 0, elevationGainM: null },
    { modality: "indoor", distanceMeters: 30_000, elevationGainM: 120 },
    { modality: "virtual", distanceMeters: 0, elevationGainM: null },
    { modality: "virtual", distanceMeters: 30_000, elevationGainM: 120 },
  ])(
    "shows training stats for $modality cycling with $distanceMeters reported meters",
    ({ modality, distanceMeters, elevationGainM }) => {
      render(
        <ActivityCardContent
          activity={activity({
            activityType: "cycling",
            modality,
            distanceMeters,
            distanceState: { status: "available" },
            elevationGainM,
            elevationState:
              elevationGainM === null
                ? { status: "missing", reason: "Elevation not recorded" }
                : { status: "available" },
          })}
          units={units}
          selectMode={false}
          selected={false}
        />,
      );

      expect(screen.getByText("Training Stress Score")).toBeDefined();
      expect(screen.getByText("8.5")).toBeDefined();
      expect(screen.queryByText(/^Distance/)).toBeNull();
      expect(screen.queryByText(/^Elevation/)).toBeNull();
    },
  );

  it.each([
    { activityType: "cycling", modality: "road" },
    { activityType: "cycling", modality: null },
    { activityType: "running", modality: "indoor" },
  ])("keeps recorded zero route metrics for $activityType ($modality)", (classification) => {
    render(
      <ActivityCardContent
        activity={activity({
          ...classification,
          distanceMeters: 0,
          distanceState: { status: "available" },
          elevationGainM: 0,
          elevationState: { status: "available" },
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByText("Distance")).toBeDefined();
    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.getByText("Elevation")).toBeDefined();
    expect(screen.getByText("0 m")).toBeDefined();
  });

  it("keeps a map panel while the server prepares location data", () => {
    render(
      <ActivityCardContent
        activity={activity({ location: { kind: "processing" } })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );

    expect(screen.getByTestId("activity-secondary-panel")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
  });

  it("keeps climbing metrics beside a source-location preview", () => {
    render(
      <ActivityCardContent
        activity={activity({
          activityType: "climbing",
          stats: [{ status: "available", label: "Climbs", value: "3" }],
          location: {
            kind: "climbing_source",
            mapPreview: {
              width: 512,
              height: 288,
              center: [0, 0] satisfies [number, number],
              zoom: 0,
              routePath: null,
            },
            sourcePoints: [
              {
                x: 256,
                y: 144,
                location: {
                  coordinates: { latitude: 37, longitude: -122 },
                  scope: "area",
                  objectId: "area-1",
                  providerId: "mountain-project",
                  name: "North Wall",
                },
              },
            ],
          },
        })}
        units={units}
        selectMode={false}
        selected={false}
      />,
    );
    expect(screen.getByTestId("activity-secondary-panel")).toBeDefined();
    expect(screen.getByText("Climbs")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.queryByText("Distance unavailable")).toBeNull();
    expect(screen.queryByText("Elevation unavailable")).toBeNull();
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

  it("gives mapped activities a full-height map pane and keeps metrics with the details", async () => {
    render(
      <ActivityCardContent
        activity={activity({
          activityType: "running",
          source: {
            origin: {
              status: "resolved",
              memberActivityId: "00000000-0000-4000-8000-000000000001",
              providerId: "whoop",
              sourceName: null,
            },
            tree: {
              primary: {
                id: "source-whoop",
                providerId: "whoop",
                sourceName: null,
                label: "WHOOP (Cloud)",
                description: null,
                url: null,
                children: [],
              },
              otherSources: [],
            },
            primarySourceLabel: "WHOOP",
            sourceCount: 1,
            overlapSummary: null,
          },
          distanceMeters: 5000,
          distanceState: { status: "available" },
          elevationGainM: 120,
          elevationState: { status: "available" },
          location: {
            kind: "recorded_gps",
            centroidLat: 37.7749,
            centroidLng: -122.4194,
            mapPreview: {
              width: 256,
              height: 256,
              center: [0, 0] satisfies [number, number],
              zoom: 0,
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
    await finishMapSnapshot();
    expect(screen.getByTestId("activity-map-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,map",
    );
    expect(screen.getByLabelText("Activity location map")).toBeDefined();
    expect(screen.getByTestId("activity-type-icon")).toBeVisible();
    expect(screen.getByRole("button", { name: "WHOOP (Cloud) Sources" })).toBeVisible();
    expect(screen.getByTestId("activity-detail-metrics")).toBeDefined();
    expect(screen.queryByText("No route recorded")).toBeNull();
    expect(screen.getByTestId("activity-secondary-panel")).toBeDefined();
    expect(screen.getByTestId("activity-secondary-inset").className).toContain("rounded-lg");
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
            kind: "recorded_gps",
            centroidLat: 37.7749,
            centroidLng: -122.4194,
            mapPreview: {
              width: 256,
              height: 256,
              center: [0, 0] satisfies [number, number],
              zoom: 0,
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

  it.each(["stale", "failed", "processing", "conflicting"] as const)(
    "renders a distinct %s server-authored state",
    (status) => {
      render(
        <ActivityCardContent
          activity={activity({
            stats: [
              { status, label: "Training Stress Score", reason: "Sync the source and retry." },
            ],
          })}
          units={units}
          selectMode={false}
          selected={false}
        />,
      );

      expect(screen.getByText(`Training Stress Score ${status}`)).toBeDefined();
      expect(screen.getByText("Sync the source and retry.")).toBeDefined();
      expect(screen.queryByText("—")).toBeNull();
    },
  );
});
