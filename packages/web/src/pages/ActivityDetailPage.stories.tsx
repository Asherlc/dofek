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
  name: "Morning Ride",
  notes: null,
  providerId: "wahoo",
  sourceProviders: ["wahoo", "apple_health"],
  sourceLinks: [
    { providerId: "wahoo", label: "Wahoo", url: "https://cloud.wahoo.com/workouts/42" },
  ],
  avgHr: 145,
  maxHr: 175,
  avgPower: 220,
  maxPower: 450,
  avgSpeed: 8.5,
  maxSpeed: 15.2,
  avgCadence: 85,
  totalDistance: 42000,
  elevationGain: 350,
  elevationLoss: 340,
  sampleCount: 5400,
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

export const CyclingMetric: HeaderStory = {};

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
