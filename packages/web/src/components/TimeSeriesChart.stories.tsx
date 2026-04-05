import { chartColors } from "@dofek/scoring/colors";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TimeSeriesChart } from "./TimeSeriesChart";

function generateDailyData(
  days: number,
  generator: (index: number) => number | null,
): [string, number | null][] {
  const data: [string, number | null][] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    data.push([dateStr, generator(i)]);
  }
  return data;
}

const stepsData = generateDailyData(30, (index) => 6000 + Math.round(Math.sin(index * 0.5) * 3000));
const hrvData = generateDailyData(30, (index) => 45 + Math.round(Math.cos(index * 0.3) * 15));
const spo2Data = generateDailyData(30, (index) => 96 + Math.round(Math.sin(index * 0.4) * 2));
const skinTempData = generateDailyData(30, (index) =>
  index % 5 === 0 ? null : 33 + Math.round(Math.cos(index * 0.2) * 10) / 10,
);

const meta = {
  title: "Charts/TimeSeriesChart",
  component: TimeSeriesChart,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: 600 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeSeriesChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Steps: Story = {
  args: {
    series: [{ name: "Steps", data: stepsData, color: chartColors.purple, areaStyle: true }],
    yAxis: [{ name: "steps" }],
  },
};

export const HeartRateVariability: Story = {
  args: {
    series: [{ name: "HRV", data: hrvData, color: chartColors.teal }],
    yAxis: [{ name: "ms" }],
  },
};

export const DualAxis: Story = {
  args: {
    series: [
      { name: "SpO2", data: spo2Data, color: chartColors.blue, areaStyle: true },
      { name: "Skin Temp", data: skinTempData, color: chartColors.amber, yAxisIndex: 1 },
    ],
    yAxis: [{ name: "SpO2 (%)", min: 90 }, { name: "°C" }],
  },
};

export const WithNullGaps: Story = {
  args: {
    series: [
      {
        name: "Sporadic Data",
        data: generateDailyData(30, (index) => (index % 3 === 0 ? null : 50 + index * 2)),
        color: chartColors.green,
        areaStyle: true,
      },
    ],
    yAxis: [{ name: "value" }],
  },
};

export const AllNull: Story = {
  args: {
    series: [
      {
        name: "Steps",
        data: generateDailyData(30, () => null),
        color: chartColors.purple,
        areaStyle: true,
      },
    ],
    yAxis: [{ name: "steps" }],
  },
};

export const Loading: Story = {
  args: {
    series: [],
    loading: true,
  },
};

export const CustomHeight: Story = {
  args: {
    series: [{ name: "Steps", data: stepsData, color: chartColors.purple, areaStyle: true }],
    yAxis: [{ name: "steps" }],
    height: 350,
  },
};
