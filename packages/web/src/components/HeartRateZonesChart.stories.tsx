import type { Meta, StoryObj } from "@storybook/react-vite";
import { HrZonesChart, PowerZonesChart, WeeklyHrZonesChart } from "./HeartRateZonesChart.tsx";

const heartRateZones = [
  { zone: 0, label: "Below Zone 1", minPct: 0, maxPct: 50, seconds: 180, percent: 5.8 },
  { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 9.7 },
  { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 1200, percent: 38.7 },
  { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 900, percent: 29 },
  { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 400, percent: 12.9 },
  { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 120, percent: 3.9 },
];

const emptyHeartRateZones = heartRateZones.map((zone) => ({
  ...zone,
  seconds: 0,
  percent: 0,
}));

const powerZones = [
  { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 240, percent: 6.6 },
  { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 1800, percent: 49.8 },
  { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 900, percent: 24.9 },
  { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 420, percent: 11.6 },
  { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 180, percent: 5 },
  { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 60, percent: 1.7 },
  { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 15, percent: 0.4 },
];

const weeklyHeartRateZones = [
  {
    week: "2026-05-04",
    zone0: 600,
    zone1: 1800,
    zone2: 5400,
    zone3: 900,
    zone4: 420,
    zone5: 120,
  },
  {
    week: "2026-05-11",
    zone0: 300,
    zone1: 1200,
    zone2: 4200,
    zone3: 1800,
    zone4: 900,
    zone5: 300,
  },
];

const meta = {
  title: "Components/HeartRateZonesChart",
  component: HrZonesChart,
  tags: ["autodocs"],
  args: {
    loading: false,
    zones: heartRateZones,
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

export const Loading: Story = {
  args: {
    loading: true,
  },
};

export const NoData: Story = {
  args: {
    zones: emptyHeartRateZones,
  },
};

export const ErrorState: Story = {
  args: {
    errorMessage: "Unable to load heart rate zones",
  },
};

export const PowerDistribution: Story = {
  render: () => <PowerZonesChart zones={powerZones} ftp={250} loading={false} />,
};

export const WeeklyDistribution: Story = {
  render: () => <WeeklyHrZonesChart weeks={weeklyHeartRateZones} maxHr={190} />,
};
