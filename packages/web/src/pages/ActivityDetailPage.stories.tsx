import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import { activityPhotoFixture } from "../components/ActivityPhoto.fixtures.ts";
import {
  walkingHardware,
  walkingSourceTree,
} from "../components/ActivitySourceDisclosure.fixtures.ts";
import { detailSourceTree, removedDetailSourceTree } from "./ActivityDetailPage.fixtures.ts";
import { ActivityHeader } from "./ActivityDetailPage.tsx";

// ── ActivityHeader ──────────────────────────────────────────

const baseActivity: ActivityDetail = {
  id: "abc-123",
  activityType: "cycling",
  primaryActivityType: null,
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
  args: {
    powerWork: { workKilojoules: 1188, coverage: { coveredSeconds: 5400, coveragePct: 100 } },
  },
};

export const IndoorCycling: HeaderStory = {
  args: {
    activity: {
      ...baseActivity,
      name: "45 min Power Zone Ride",
      modality: "indoor",
      endedAt: "2026-03-31T08:45:00Z",
      totalDistance: 0,
      elevationGain: null,
      elevationGainState: missingMetricState("Elevation gain"),
      avgPower: 177,
      maxPower: 294,
      avgSpeed: null,
      avgSpeedState: missingMetricState("Average speed"),
      avgCadence: 71,
    },
    powerWork: { workKilojoules: 477.8, coverage: { coveredSeconds: 2700, coveragePct: 100 } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.queryByText("Distance")).not.toBeInTheDocument();
    await expect(canvas.getByText("Energy Output")).toBeVisible();
    await expect(canvas.getByText("478 kJ")).toBeVisible();
  },
};

export const PartialPowerOutput: HeaderStory = {
  args: {
    ...IndoorCycling.args,
    powerWork: { workKilojoules: 400, coverage: { coveredSeconds: 2200, coveragePct: 81.5 } },
  },
};

export const WalkingSourcesCollapsed: HeaderStory = {
  parameters: { layout: "padded" },
  args: {
    activity: {
      ...baseActivity,
      name: "67 min 59 sec Walking",
      activityType: "hiking",
      startedAt: "2026-10-24T18:52:00Z",
      endedAt: "2026-10-24T20:45:00Z",
      displayedDate: "2026-10-24",
      sourceTree: walkingSourceTree,
      totalDistance: 6598,
      elevationGain: 303.6,
      avgHr: 108,
      maxHr: 141,
      avgSpeed: 0.9835,
      avgPower: null,
      avgPowerState: missingMetricState("Average power"),
      maxPower: null,
      maxPowerState: missingMetricState("Maximum power"),
      avgCadence: null,
      avgCadenceState: missingMetricState("Cadence"),
    },
    units: new UnitConverter("imperial"),
    hardware: walkingHardware,
  },
};

export const WalkingSourcesExpanded: HeaderStory = {
  parameters: { layout: "padded" },
  args: WalkingSourcesCollapsed.args,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Asher’s Apple Watch Sources" }));
    await expect(canvas.getByText("Whoop")).toBeVisible();
    await expect(canvas.getByText("Apple Health")).toBeVisible();
  },
};

export const PrimarySourceWithoutTitle: HeaderStory = {
  ...WalkingSourcesCollapsed,
  args: {
    ...WalkingSourcesCollapsed.args,
    activity: {
      ...baseActivity,
      ...WalkingSourcesCollapsed.args?.activity,
      name: null,
      activityType: "walking",
      primaryActivityType: "running",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByRole("heading", { name: "Running" })).toBeVisible();
    await expect(canvas.getByText("Walking")).toBeVisible();
  },
};

export const BranchingCollapsed: HeaderStory = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByRole("button", { name: "Garmin Edge 530 Sources" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(canvas.queryByText("Strava")).toBeNull();
  },
};

export const BranchingExpanded: HeaderStory = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Garmin Edge 530 Sources" }));
    await expect(canvas.getAllByText("Garmin Edge 530")).toHaveLength(1);
    await expect(canvas.getAllByText("Apple Health")).toHaveLength(2);
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
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Sources" }));
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};

export const RemovedSources: HeaderStory = {
  args: { activity: { ...baseActivity, sourceTree: removedDetailSourceTree } },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Garmin Edge 530 Sources" }));
    await expect(canvas.getAllByText("Removed from provider")[0]).toBeVisible();
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

export const WithPhoto: HeaderStory = {
  parameters: { layout: "padded" },
  args: {
    ...IndoorCycling.args,
    activity: {
      ...baseActivity,
      ...IndoorCycling.args?.activity,
      name: "45 min Power Zone Endurance Ride",
    },
    photos: {
      images: [activityPhotoFixture],
      loading: false,
      error: null,
      onRetry: () => undefined,
    },
  },
};
export const WithMultiplePhotos: HeaderStory = {
  parameters: { layout: "padded" },
  args: {
    ...WithPhoto.args,
    photos: {
      images: [activityPhotoFixture, { ...activityPhotoFixture, id: "photo-2" }],
      loading: false,
      error: null,
      onRetry: () => undefined,
    },
  },
};
export const PhotoRefreshError: HeaderStory = {
  parameters: { layout: "padded" },
  args: {
    ...WithPhoto.args,
    photos: {
      images: [activityPhotoFixture],
      loading: false,
      error: new Error("Photo storage is unavailable. Try again."),
      onRetry: () => undefined,
    },
  },
};
