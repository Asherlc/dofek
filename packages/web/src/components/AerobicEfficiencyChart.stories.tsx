import type { Meta, StoryObj } from "@storybook/react-vite";
import { AerobicEfficiencyChart } from "./AerobicEfficiencyChart.tsx";

const activities = [
  {
    date: "2026-05-04",
    activityType: "cycling",
    name: "Endurance Ride",
    avgPowerZ2: 176,
    avgHrZ2: 136,
    efficiencyFactor: 1.294,
    z2Samples: 2100,
  },
  {
    date: "2026-05-11",
    activityType: "cycling",
    name: "Cafe Loop",
    avgPowerZ2: 184,
    avgHrZ2: 134,
    efficiencyFactor: 1.373,
    z2Samples: 1800,
  },
  {
    date: "2026-05-18",
    activityType: "cycling",
    name: "Steady Spin",
    avgPowerZ2: 188,
    avgHrZ2: 132,
    efficiencyFactor: 1.424,
    z2Samples: 2400,
  },
];

const meta = {
  title: "Components/AerobicEfficiencyChart",
  component: AerobicEfficiencyChart,
  tags: ["autodocs"],
  args: {
    activities,
    maxHr: 190,
    loading: false,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 600 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AerobicEfficiencyChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    activities: [],
    loading: true,
  },
};

export const NoData: Story = {
  args: {
    activities: [],
    maxHr: null,
  },
};
