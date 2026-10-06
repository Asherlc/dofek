import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MetricsChart } from "./ActivityDetailPage.tsx";

const meta = {
  title: "Pages/ActivityDetail/Charts",
  component: MetricsChart,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="p-6">
        <Story />
      </div>
    ),
  ],
  args: {
    points: [
      {
        recordedAt: "2026-10-04T16:52:51.440Z",
        heartRate: 152,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
      {
        recordedAt: "2026-10-04T16:53:51.440Z",
        heartRate: 140,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
      {
        recordedAt: "2026-10-04T16:54:51.440Z",
        heartRate: 145,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
    ],
    activityType: "running",
    hasHr: true,
    hasPower: false,
    hasSpeed: false,
    hasCadence: false,
    loading: false,
    units: new UnitConverter("metric"),
  },
} satisfies Meta<typeof MetricsChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalizedTooltip: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { points: [] } };
