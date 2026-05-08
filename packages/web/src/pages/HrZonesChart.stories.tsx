import type { Meta, StoryObj } from "@storybook/react-vite";
import { HrZonesChart } from "./ActivityDetailPage.tsx";

const meta = {
  title: "Pages/ActivityDetail/HrZonesChart",
  component: HrZonesChart,
  tags: ["autodocs"],
  args: {
    loading: false,
    zones: [
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 10.3 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 1200, percent: 41.1 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 900, percent: 30.8 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 400, percent: 13.7 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 120, percent: 4.1 },
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
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 600, percent: 17.9 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 2400, percent: 71.4 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 300, percent: 8.9 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 60, percent: 1.8 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 0, percent: 0 },
    ],
  },
};

export const HighIntensity: Story = {
  args: {
    zones: [
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 60, percent: 2.7 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 180, percent: 8 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 600, percent: 26.8 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 900, percent: 40.2 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 500, percent: 22.3 },
    ],
  },
};

export const NoData: Story = {
  args: {
    zones: [
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 0, percent: 0 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 0, percent: 0 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 0, percent: 0 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 0, percent: 0 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 0, percent: 0 },
    ],
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};

export const ErrorState: Story = {
  args: {
    errorMessage: "Unable to load heart rate zones",
  },
};
