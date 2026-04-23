import type { Meta, StoryObj } from "@storybook/react-vite";
import { PowerZonesChart } from "./ActivityDetailPage.tsx";

const meta = {
  title: "Pages/ActivityDetail/PowerZonesChart",
  component: PowerZonesChart,
  tags: ["autodocs"],
  args: {
    loading: false,
    ftp: 250,
    zones: [
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 240 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 1800 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 900 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 420 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 180 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 60 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 15 },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 600 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PowerZonesChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const EnduranceRide: Story = {
  args: {
    zones: [
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 600 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 4200 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 600 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 120 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 30 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 0 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 0 },
    ],
  },
};

export const Intervals: Story = {
  args: {
    zones: [
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 900 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 600 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 240 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 480 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 720 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 300 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 45 },
    ],
  },
};

export const NoData: Story = {
  args: {
    zones: [
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 0 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 0 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 0 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 0 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 0 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 0 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 0 },
    ],
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};
