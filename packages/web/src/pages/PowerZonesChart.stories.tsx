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
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 240, percent: 6.6 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 1800, percent: 49.8 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 900, percent: 24.9 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 420, percent: 11.6 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 180, percent: 5 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 60, percent: 1.7 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 15, percent: 0.4 },
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
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 600, percent: 10.8 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 4200, percent: 75.7 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 600, percent: 10.8 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 120, percent: 2.2 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 30, percent: 0.5 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 0, percent: 0 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 0, percent: 0 },
    ],
  },
};

export const Intervals: Story = {
  args: {
    zones: [
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 900, percent: 27.4 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 600, percent: 18.3 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 240, percent: 7.3 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 480, percent: 14.6 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 720, percent: 21.9 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 300, percent: 9.1 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 45, percent: 1.4 },
    ],
  },
};

export const NoData: Story = {
  args: {
    zones: [
      { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 0, percent: 0 },
      { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 0, percent: 0 },
      { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 0, percent: 0 },
      { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 0, percent: 0 },
      { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 0, percent: 0 },
      { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 0, percent: 0 },
      { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 0, percent: 0 },
    ],
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};
