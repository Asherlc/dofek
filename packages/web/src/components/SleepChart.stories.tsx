import type { Meta, StoryObj } from "@storybook/react-vite";
import { SleepChart } from "./SleepChart";

const sampleData = [
  {
    started_at: "2026-03-27T12:00:00",
    duration_minutes: 488,
    deep_minutes: 90,
    rem_minutes: 110,
    light_minutes: 250,
    awake_minutes: 38,
    efficiency_pct: 92,
  },
  {
    started_at: "2026-03-28T12:00:00",
    duration_minutes: 505,
    deep_minutes: 100,
    rem_minutes: 95,
    light_minutes: 270,
    awake_minutes: 40,
    efficiency_pct: 91,
  },
  {
    started_at: "2026-03-29T12:00:00",
    duration_minutes: 473,
    deep_minutes: 85,
    rem_minutes: 105,
    light_minutes: 245,
    awake_minutes: 38,
    efficiency_pct: 90,
  },
  {
    started_at: "2026-03-30T12:00:00",
    duration_minutes: 454,
    deep_minutes: 70,
    rem_minutes: 90,
    light_minutes: 260,
    awake_minutes: 34,
    efficiency_pct: 88,
  },
  {
    started_at: "2026-03-31T12:00:00",
    duration_minutes: 481,
    deep_minutes: 95,
    rem_minutes: 100,
    light_minutes: 250,
    awake_minutes: 36,
    efficiency_pct: 93,
  },
  {
    started_at: "2026-04-01T12:00:00",
    duration_minutes: null,
    deep_minutes: null,
    rem_minutes: null,
    light_minutes: null,
    awake_minutes: null,
    efficiency_pct: null,
  },
  {
    started_at: "2026-04-02T12:00:00",
    duration_minutes: 510,
    deep_minutes: 105,
    rem_minutes: 115,
    light_minutes: 255,
    awake_minutes: 35,
    efficiency_pct: 94,
  },
];

const meta = {
  title: "Sleep/SleepChart",
  component: SleepChart,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: 700 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    data: sampleData,
  },
} satisfies Meta<typeof SleepChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: { loading: true },
};

export const Empty: Story = {
  args: { data: [] },
};

export const SingleNight: Story = {
  args: { data: sampleData.slice(0, 1) },
};
