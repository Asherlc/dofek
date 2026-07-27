import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityCardContent, type ActivityCardData } from "./ActivityCardContent.tsx";

const units = new UnitConverter("metric");

const strengthActivity: ActivityCardData = {
  id: "strength-1",
  name: null,
  activityType: "strength_training",
  startedAt: "2026-07-14T08:46:00-07:00",
  durationMin: 30,
  location: null,
  stats: [{ label: "Training Stress Score", value: "8.5" }],
};

const mappedActivity: ActivityCardData = {
  id: "run-1",
  name: "Morning Run",
  activityType: "running",
  startedAt: "2026-07-14T07:38:00-07:00",
  durationMin: 64,
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
    distanceMeters: 8530,
    elevationGainM: 493,
  },
  stats: [{ label: "Training Stress Score", value: "41" }],
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

export const ExampleGrid: Story = {
  render: () => (
    <div className="grid gap-4 lg:grid-cols-2">
      {[mappedActivity, strengthActivity].map((activity) => (
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
