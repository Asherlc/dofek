import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityCardContent, type ActivityCardData } from "./ActivityCardContent.tsx";

const units = new UnitConverter("metric");

const strengthActivity: ActivityCardData = {
  id: "strength-1",
  name: null,
  activityType: "strength",
  startedAt: "2026-07-14T08:46:00-07:00",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  durationMin: 30,
  source: {
    primarySourceLabel: "Strong (via Apple Health)",
    sourceCount: 1,
    overlapSummary: null,
  },
  lastProcessedAt: "2026-07-14T08:50:00-07:00",
  distanceMeters: null,
  distanceState: { status: "missing", reason: "Distance not recorded" },
  elevationGainM: null,
  elevationState: { status: "missing", reason: "Elevation not recorded" },
  location: null,
  stats: [{ status: "available", label: "Training Stress Score", value: "8.5" }],
};

const unavailableTrainingStressActivity: ActivityCardData = {
  ...strengthActivity,
  id: "strength-unavailable",
  stats: [
    {
      status: "missing",
      label: "Training Stress Score",
      reason: "Record average power, or record average heart rate and set maximum heart rate.",
    },
  ],
};

const unknownLocalTimeActivity: ActivityCardData = {
  ...strengthActivity,
  id: "strength-unknown-local-time",
  localTimeContext: {
    timezone: null,
    startUtcOffsetMinutes: null,
    endUtcOffsetMinutes: null,
    source: "unknown",
  },
};

const mappedActivity: ActivityCardData = {
  id: "run-1",
  name: "Morning Run",
  activityType: "running",
  startedAt: "2026-07-14T07:38:00-07:00",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "device_timezone",
  },
  durationMin: 64,
  source: {
    primarySourceLabel: "Garmin Connect",
    sourceCount: 2,
    overlapSummary: "2 matched source records · Garmin Connect selected by source priority",
  },
  lastProcessedAt: "2026-07-14T08:45:00-07:00",
  distanceMeters: 8530,
  distanceState: { status: "available" },
  elevationGainM: 493,
  elevationState: { status: "available" },
  location: {
    mapPreview: {
      width: 512,
      height: 512,
      tiles: [
        {
          url: "https://tile.openstreetmap.org/19/83858/202646.png",
          x: 0,
          y: 0,
          width: 256,
          height: 256,
        },
        {
          url: "https://tile.openstreetmap.org/19/83859/202646.png",
          x: 256,
          y: 0,
          width: 256,
          height: 256,
        },
        {
          url: "https://tile.openstreetmap.org/19/83858/202647.png",
          x: 0,
          y: 256,
          width: 256,
          height: 256,
        },
        {
          url: "https://tile.openstreetmap.org/19/83859/202647.png",
          x: 256,
          y: 256,
          width: 256,
          height: 256,
        },
      ],
      routePath: [
        { x: 82, y: 410 },
        { x: 178, y: 332 },
        { x: 264, y: 286 },
        { x: 356, y: 178 },
        { x: 438, y: 92 },
      ],
    },
  },
  stats: [{ status: "available", label: "Training Stress Score", value: "41" }],
};

const meta = {
  title: "Activities/ActivityCardContent",
  component: ActivityCardContent,
  tags: ["autodocs"],
  args: {
    activity: strengthActivity,
    units,
    selectMode: false,
    selected: false,
  },
  decorators: [
    (Story) => (
      <div className="w-[1400px] max-w-full bg-background p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityCardContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NonMapActivity: Story = {
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const MappedActivity: Story = {
  args: { activity: mappedActivity },
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const UnavailableTrainingStress: Story = {
  args: { activity: unavailableTrainingStressActivity },
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const UnknownLocalTime: Story = {
  args: { activity: unknownLocalTimeActivity },
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const ExampleGrid: Story = {
  render: () => (
    <div className="grid gap-4 lg:grid-cols-2">
      {[mappedActivity, strengthActivity, unavailableTrainingStressActivity].map((activity) => (
        <article key={activity.id} className="card h-full overflow-hidden">
          <ActivityCardContent
            activity={activity}
            units={units}
            selectMode={false}
            selected={false}
          />
        </article>
      ))}
    </div>
  ),
};
