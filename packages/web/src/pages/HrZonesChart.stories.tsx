import type { Meta, StoryObj } from "@storybook/react-vite";
import { HrZonesChart } from "./ActivityDetailPage.tsx";

const meta = {
  title: "Pages/ActivityDetail/HrZonesChart",
  component: HrZonesChart,
  tags: ["autodocs"],
  args: {
    loading: false,
    zones: [
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 1200 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 900 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 400 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 120 },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 600 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HrZonesChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MostlyAerobic: Story = {
  args: {
    zones: [
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 600 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 2400 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 300 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 60 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 0 },
    ],
  },
};

export const HighIntensity: Story = {
  args: {
    zones: [
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 60 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 180 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 600 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 900 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 500 },
    ],
  },
};

export const NoData: Story = {
  args: {
    zones: [
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 0 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 0 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 0 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 0 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 0 },
    ],
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};
