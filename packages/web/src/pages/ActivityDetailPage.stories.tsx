import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import { ActivityHeader } from "./ActivityDetailPage.tsx";

// ── ActivityHeader ──────────────────────────────────────────

const baseActivity: ActivityDetail = {
  id: "abc-123",
  activityType: "cycling",
  startedAt: "2026-03-31T08:00:00Z",
  endedAt: "2026-03-31T09:30:00Z",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  name: "Morning Ride",
  notes: null,
  providerId: "wahoo",
  subsource: null,
  sourceProviders: ["wahoo", "apple_health"],
  sourceLinks: [
    {
      providerId: "wahoo",
      externalId: "42",
      subsource: null,
      label: "Wahoo",
      url: "https://systm.wahoofitness.com/history/activity-details/42",
      providerAbsentAt: null,
    },
  ],
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
      maxPower: null,
      totalDistance: 8000,
      elevationGain: 50,
      elevationLoss: 45,
      avgSpeed: 3.2,
      avgCadence: 170,
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
      maxHr: null,
      avgPower: null,
      maxPower: null,
      avgSpeed: null,
      maxSpeed: null,
      avgCadence: null,
      totalDistance: null,
      elevationGain: null,
      elevationLoss: null,
      sourceProviders: [],
      sourceLinks: [],
    },
  },
};
