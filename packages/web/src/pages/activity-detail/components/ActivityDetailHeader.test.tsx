// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { strongSourceTree } from "../../../components/ActivitySourceDisclosure.fixtures.ts";
import {
  baseActivity,
  detailSourceTree,
  removedDetailSourceTree,
} from "../../ActivityDetailPage.fixtures.ts";
import { ActivityHeader } from "./ActivityDetailHeader.tsx";

it("renders measured and unavailable metrics with the real source disclosure", () => {
  render(
    <ActivityHeader
      activity={{
        ...baseActivity,
        sourceTree: detailSourceTree,
        activityType: "running",
        avgHr: 0,
        avgHrState: { status: "available" },
        totalDistance: null,
        totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      }}
      units={new UnitConverter("metric")}
    />,
  );

  expect(screen.getByRole("heading", { name: "Morning Ride" })).toBeVisible();
  expect(screen.getByText("0 bpm")).toBeVisible();
  expect(screen.getByText("Avg Power")).toBeVisible();
  expect(screen.queryByText("Distance unavailable")).toBeNull();
  expect(screen.queryByText("Distance not recorded")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Garmin Edge 530 Lineage" }));
  expect(screen.getByText("Strava")).toBeVisible();
  expect(screen.getByText("WHOOP")).toBeVisible();
});

it("renders a 125-minute duration as two hours and five minutes", () => {
  render(
    <ActivityHeader
      activity={{ ...baseActivity, durationMin: 125 }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("2h 5m")).toBeVisible();
});

it("preserves Strong recording attribution when flat source links are empty", () => {
  render(
    <ActivityHeader
      activity={{
        ...baseActivity,
        sourceLinks: [],
        sourceProviders: [],
        sourceTree: strongSourceTree,
      }}
      units={new UnitConverter("metric")}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Strong Lineage" }));
  expect(screen.getByText("Recording app reported by Apple Health")).toBeVisible();
  expect(screen.getByText("Apple Health")).toBeVisible();
  expect(screen.getByText("Recorded by Strong")).toBeVisible();
});

it("keeps the activity heading when an expandable source tree has no primary", () => {
  render(
    <ActivityHeader
      activity={{
        ...baseActivity,
        sourceTree: { primary: null, otherSources: detailSourceTree.otherSources },
      }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByRole("heading", { name: "Morning Ride" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
  expect(screen.getByRole("region", { name: "Available recordings" })).toHaveTextContent("WHOOP");
});

it("uses fallback title without lineage for empty optional source metadata", () => {
  render(
    <ActivityHeader
      activity={{
        ...baseActivity,
        activityType: "running",
        name: null,
        sourceLinks: [],
        sourceProviders: [],
        sourceTree: { primary: null, otherSources: [] },
      }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByRole("heading", { name: "Running" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Lineage/ })).toBeNull();
  expect(screen.getByText("42.0 km")).toBeVisible();
});

it("uses the UTC server calendar date at the local midnight boundary", () => {
  render(
    <ActivityHeader
      activity={{ ...baseActivity, startedAt: "2026-03-18T00:30:00Z", displayedDate: "2026-03-18" }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText(/Mar 18, 2026/)).toBeVisible();
});

it("keeps removed source records visible without links while retaining active sources", () => {
  render(
    <ActivityHeader
      activity={{ ...baseActivity, sourceTree: removedDetailSourceTree }}
      units={new UnitConverter("metric")}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Garmin Edge 530 Lineage" }));
  expect(screen.getAllByText("Removed from provider")).toHaveLength(2);
  expect(screen.getByText("Strava").closest("a")).toBeNull();
  expect(screen.queryByRole("link", { name: "Garmin Edge 530" })).toBeNull();
  expect(screen.getByRole("link", { name: "WHOOP" })).toHaveAttribute(
    "href",
    "https://app.whoop.com/activities/123",
  );
});

it("shows power work attribution and the partial coverage description", () => {
  render(
    <ActivityHeader
      activity={baseActivity}
      powerWork={{ workKilojoules: 1234, coverage: { coveredSeconds: 100, coveragePct: 90 } }}
      powerWorkSourceHint="Showing previous power zone readings from Garmin"
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("Energy Output")).toBeVisible();
  expect(screen.getByText("Partial power data")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Showing previous power zone readings from Garmin",
  );
});

it.each(["metric", "imperial"] as const)(
  "rounds server-calculated energy output independently of %s units",
  (unitSystem) => {
    render(
      <ActivityHeader
        activity={{ ...baseActivity, activityType: "cycling" }}
        powerWork={{ workKilojoules: 477.8, coverage: { coveredSeconds: 2700, coveragePct: 100 } }}
        units={new UnitConverter(unitSystem)}
      />,
    );
    expect(screen.getByText("478 kJ")).toBeVisible();
    expect(screen.queryByText("Partial power data")).toBeNull();
  },
);

it.each([
  { workKilojoules: 0, coverage: { coveredSeconds: 2700, coveragePct: 100 }, expected: "0 kJ" },
  { workKilojoules: null, coverage: { coveredSeconds: 0, coveragePct: 0 }, expected: null },
])("distinguishes zero from missing energy output", ({ workKilojoules, coverage, expected }) => {
  render(
    <ActivityHeader
      activity={{ ...baseActivity, activityType: "cycling" }}
      powerWork={{ workKilojoules, coverage }}
      units={new UnitConverter("metric")}
    />,
  );
  if (expected) expect(screen.getByText(expected)).toBeVisible();
  else expect(screen.queryByText("Energy Output")).toBeNull();
});

it.each([
  { coveragePct: 98.9, partial: true },
  { coveragePct: 99, partial: false },
])("qualifies power work at the 99 percent boundary ($coveragePct)", ({ coveragePct, partial }) => {
  render(
    <ActivityHeader
      activity={{ ...baseActivity, activityType: "cycling" }}
      powerWork={{ workKilojoules: 400, coverage: { coveredSeconds: 2600, coveragePct } }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("400 kJ")).toBeVisible();
  expect(screen.queryByText("Partial power data") !== null).toBe(partial);
});

it.each(["indoor", "virtual"] as const)("omits simulated distance for %s cycling", (modality) => {
  render(
    <ActivityHeader
      activity={{ ...baseActivity, activityType: "cycling", modality, totalDistance: 25000 }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.queryByText("Distance")).toBeNull();
  expect(screen.getByText("Duration")).toBeVisible();
});

it.each([
  { activityType: "hiking", cadence: 85, label: "85 steps/min" },
  { activityType: "cycling", cadence: 90, label: "90 rpm" },
])(
  "shows the activity-specific cadence label for $activityType",
  ({ activityType, cadence, label }) => {
    render(
      <ActivityHeader
        activity={{ ...baseActivity, activityType, avgCadence: cadence }}
        units={new UnitConverter("metric")}
      />,
    );
    expect(screen.getByText(label)).toBeVisible();
  },
);

it("omits the header Avg Cadence stat when Running Form supplies cadence", () => {
  render(
    <ActivityHeader
      activity={{
        ...baseActivity,
        activityType: "running",
        runningForm: {
          cadence: 170,
          cadenceBasis: "step_intervals",
          cadenceObservedSeconds: 2400,
          cadenceCoveragePercent: 92,
          strideLengthMeters: null,
          stanceTimeMs: null,
          verticalOscillationMm: null,
        },
      }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.queryByText(/Avg Cadence/)).toBeNull();
  expect(screen.queryByText("170 steps/min")).toBeNull();
});

it.each([
  {
    name: "non-running activities",
    activity: { ...baseActivity, activityType: "cycling" },
    cadence: "85 rpm",
  },
  {
    name: "older detail responses without Running Form",
    activity: { ...baseActivity, activityType: "running" },
    cadence: "85 steps/min",
  },
  {
    name: "Running Form without a cadence reading",
    activity: {
      ...baseActivity,
      activityType: "running",
      runningForm: {
        cadence: null,
        cadenceBasis: "unknown" as const,
        cadenceObservedSeconds: null,
        cadenceCoveragePercent: null,
        strideLengthMeters: 0.9,
        stanceTimeMs: null,
        verticalOscillationMm: null,
      },
    },
    cadence: "85 steps/min",
  },
])("keeps the header Avg Cadence stat for $name", ({ activity, cadence }) => {
  render(<ActivityHeader activity={activity} units={new UnitConverter("metric")} />);
  expect(screen.getByText(cadence)).toBeVisible();
});

it("retains a measured zero distance and formats the selected distance and speed units", () => {
  const { rerender } = render(
    <ActivityHeader
      activity={{ ...baseActivity, modality: "outdoor", totalDistance: 0 }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText("0.0 km")).toBeVisible();
  expect(screen.getByText("30.6 km/h")).toBeVisible();

  rerender(
    <ActivityHeader
      activity={{
        ...baseActivity,
        modality: "outdoor",
        totalDistance: 10000,
        elevationGain: 200,
      }}
      units={new UnitConverter("imperial")}
    />,
  );
  expect(screen.getByText("6.2 mi")).toBeVisible();
  expect(screen.getByText("19.0 mph")).toBeVisible();
  expect(screen.getByText("656 ft")).toBeVisible();
});

it.each([
  { system: "metric", expected: "5:33 /km" },
  { system: "imperial", expected: "8:56 /mi" },
] as const)(
  "renders Avg Pace instead of Avg Speed for a running activity with positive speed in $system units",
  ({ system, expected }) => {
    render(
      <ActivityHeader
        activity={{
          ...baseActivity,
          activityType: "running",
          avgSpeed: 3,
          avgSpeedState: { status: "available" },
        }}
        units={new UnitConverter(system)}
      />,
    );
    expect(screen.getByText("Avg Pace")).toBeVisible();
    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText("Avg Speed")).toBeNull();
  },
);

it.each([
  {
    name: "non-running activities",
    activity: { ...baseActivity, activityType: "cycling" },
  },
  {
    name: "running with zero speed",
    activity: { ...baseActivity, activityType: "running", avgSpeed: 0 },
  },
])("keeps Avg Speed for $name", ({ activity }) => {
  render(<ActivityHeader activity={activity} units={new UnitConverter("metric")} />);
  expect(screen.getByText("Avg Speed")).toBeVisible();
  expect(screen.queryByText("Avg Pace")).toBeNull();
});

it("keeps the missing speed state hidden rather than rendering Avg Pace", () => {
  render(
    <ActivityHeader
      activity={{
        ...baseActivity,
        activityType: "running",
        avgSpeed: null,
        avgSpeedState: { status: "missing", reason: "Avg Speed not recorded" },
      }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.queryByText("Avg Pace")).toBeNull();
  expect(screen.queryByText("Avg Speed")).toBeNull();
});

it("shows the FIT recovery warning and omits it for clean files", () => {
  const warning = "Some FIT data could not be recovered from the original file.";
  const { rerender } = render(
    <ActivityHeader
      activity={{ ...baseActivity, fitRecoveryWarning: warning }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(warning);
  rerender(<ActivityHeader activity={baseActivity} units={new UnitConverter("metric")} />);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("renders the server date, unknown duration, and connected Kilter climbing session", () => {
  render(
    <ActivityHeader
      activity={{
        ...baseActivity,
        activityType: "climbing",
        durationMin: null,
        endedAt: null,
        climbingLogSessions: [
          {
            id: "kilter-session-1",
            providerId: "kilter",
            memberActivityIds: ["kilter-point-1", "kilter-point-2"],
            firstLoggedAt: "2026-04-14T10:02:00.000Z",
            lastLoggedAt: "2026-04-14T10:06:33.000Z",
          },
        ],
      }}
      units={new UnitConverter("metric")}
    />,
  );
  expect(screen.getByText(/Mar 31, 2026/)).toBeVisible();
  expect(screen.getByText("Unavailable")).toBeVisible();
  expect(screen.queryByText("0m")).toBeNull();
  expect(screen.getByRole("list", { name: "Logged climbs" })).toHaveTextContent(
    /Kilter Board · Logged climbs · .+ – .+/,
  );
});

it("expands distinct server source branches and preserves unresolved recording attribution", () => {
  render(
    <ActivityHeader
      activity={{ ...baseActivity, sourceTree: detailSourceTree }}
      units={new UnitConverter("metric")}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Garmin Edge 530 Lineage" });
  fireEvent.click(trigger);
  expect(screen.getByRole("link", { name: "Garmin Edge 530" })).toHaveAttribute(
    "href",
    "https://connect.garmin.com/modern/activity/123",
  );
  const strava = screen.getByRole("link", { name: "Strava" }).closest("li");
  if (!strava) throw new Error("Expected transfer branch");
  expect(strava).toHaveTextContent("Apple Health");
  expect(screen.getByRole("region", { name: "Other" })).toHaveTextContent("WHOOP");
});

it("stacks a labeled lineage trigger under a long title so the title keeps its width", () => {
  const longName = "Kaya gym session with an unusually long activity title";
  render(
    <ActivityHeader
      activity={{ ...baseActivity, name: longName, sourceTree: detailSourceTree }}
      units={new UnitConverter("metric")}
    />,
  );

  const heading = screen.getByRole("heading", { name: longName });
  const trigger = screen.getByRole("button", { name: "Garmin Edge 530 Lineage" });
  expect(heading.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(trigger).toHaveTextContent("Garmin Edge 530");
  expect(trigger).toHaveTextContent("Lineage");
});
