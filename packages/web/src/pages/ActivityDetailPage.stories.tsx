import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import { detailSourceTree, removedDetailSourceTree } from "./ActivityDetailPage.fixtures.ts";
import { ActivityHeader } from "./ActivityDetailPage.tsx";

// ── ActivityHeader ──────────────────────────────────────────

const baseActivity: ActivityDetail = {
  id: "abc-123",
  activityType: "cycling",
  rawType: "cycling",
  modality: null,
  startedAt: "2026-03-31T08:00:00Z",
  displayedDate: "2026-03-31",
  endedAt: "2026-03-31T09:30:00Z",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  name: "Morning Ride",
  notes: null,
  perceivedExertion: null,
  providerId: "garmin",
  subsource: null,
  sourceProviders: ["garmin", "strava", "apple_health", "whoop"],
  sourceLinks: [
    {
      providerId: "garmin",
      externalId: "123",
      subsource: null,
      label: "Garmin Connect",
      url: "https://connect.garmin.com/modern/activity/123",
      providerAbsentAt: null,
    },
  ],
  sourceTree: detailSourceTree,
  avgHr: 145,
  avgHrState: { status: "available" },
  maxHr: 175,
  maxHrState: { status: "available" },
  avgPower: 220,
  avgPowerState: { status: "available" },
  maxPower: 450,
  maxPowerState: { status: "available" },
  avgSpeed: 8.5,
  avgSpeedState: { status: "available" },
  maxSpeed: 15.2,
  maxSpeedState: { status: "available" },
  avgCadence: 85,
  avgCadenceState: { status: "available" },
  totalDistance: 42000,
  totalDistanceState: { status: "available" },
  elevationGain: 350,
  elevationGainState: { status: "available" },
  elevationLoss: 340,
  elevationLossState: { status: "available" },
  sampleCount: 5400,
  sampleCountState: { status: "available" },
  providerAbsentAt: null,
  sourceDecision: null,
};

const missingMetricState = (label: string) => ({
  status: "missing" as const,
  reason: `${label} not recorded`,
});

const headerMeta = {
  title: "Pages/ActivityDetail/ActivityHeader",
  component: ActivityHeader,
  tags: ["autodocs"],
  args: {
    activity: baseActivity,
    units: new UnitConverter("metric"),
  },
} satisfies Meta<typeof ActivityHeader>;

export default headerMeta;

type HeaderStory = StoryObj<typeof headerMeta>;

export const CyclingMetric: HeaderStory = {
  args: {},
};

export const BranchingCollapsed: HeaderStory = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Garmin Edge 530 Sources" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(canvas.queryByText("Strava")).toBeNull();
  },
};

export const BranchingExpanded: HeaderStory = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Garmin Edge 530 Sources" }));
    await expect(canvas.getAllByText("Garmin Edge 530")).toHaveLength(1);
    await expect(canvas.getAllByText("Apple Health")).toHaveLength(2);
    await expect(canvas.getByText("Imported from Strava")).toBeVisible();
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};

export const EmptySources: HeaderStory = {
  args: { activity: { ...baseActivity, sourceTree: { primary: null, otherSources: [] } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("button", { name: /Sources/ })).toBeNull();
  },
};

export const UnresolvedSources: HeaderStory = {
  args: {
    activity: {
      ...baseActivity,
      sourceTree: { primary: null, otherSources: detailSourceTree.otherSources },
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Sources" }));
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};

export const RemovedSources: HeaderStory = {
  args: { activity: { ...baseActivity, sourceTree: removedDetailSourceTree } },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Garmin Edge 530 Sources" }));
    await expect(
      canvas.getByText("Closest available recording · Removed from provider"),
    ).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "Strava" })).toBeNull();
    await expect(canvas.getByRole("link", { name: "WHOOP" })).toBeVisible();
  },
};

export const CyclingImperial: HeaderStory = {
  args: {
    units: new UnitConverter("imperial"),
  },
};

export const Running: HeaderStory = {
  args: {
    activity: {
      ...baseActivity,
      activityType: "running",
      name: "Easy Run",
      avgPower: null,
      avgPowerState: missingMetricState("Average power"),
      maxPower: null,
      maxPowerState: missingMetricState("Maximum power"),
      totalDistance: 8000,
      elevationGain: 50,
      elevationLoss: 45,
      avgSpeed: 3.2,
      avgCadence: 170,
    },
  },
};

export const WithSessionEffort: HeaderStory = {
  args: {
    activity: {
      ...baseActivity,
      perceivedExertion: 7,
    },
  },
};

export const Minimal: HeaderStory = {
  args: {
    activity: {
      ...baseActivity,
      name: null,
      endedAt: null,
      avgHr: null,
      avgHrState: missingMetricState("Average heart rate"),
      maxHr: null,
      maxHrState: missingMetricState("Maximum heart rate"),
      avgPower: null,
      avgPowerState: missingMetricState("Average power"),
      maxPower: null,
      maxPowerState: missingMetricState("Maximum power"),
      avgSpeed: null,
      avgSpeedState: missingMetricState("Average speed"),
      maxSpeed: null,
      maxSpeedState: missingMetricState("Maximum speed"),
      avgCadence: null,
      avgCadenceState: missingMetricState("Average cadence"),
      totalDistance: null,
      totalDistanceState: missingMetricState("Distance"),
      elevationGain: null,
      elevationGainState: missingMetricState("Elevation gain"),
      elevationLoss: null,
      elevationLossState: missingMetricState("Elevation loss"),
      sourceProviders: [],
      sourceLinks: [],
      sourceTree: { primary: null, otherSources: [] },
    },
  },
};
