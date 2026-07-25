import type { Meta, StoryObj } from "@storybook/react-vite";
import { EftpTrendChart } from "./EftpTrendChart.tsx";

const points = [
  { date: "2026-04-06", eftp: 246, activityName: "Threshold Intervals" },
  { date: "2026-04-20", eftp: 251, activityName: "Rolling Tempo Ride" },
  { date: "2026-05-04", eftp: 255, activityName: "Twenty Minute Test" },
  { date: "2026-05-18", eftp: 259, activityName: "Long Climb" },
  { date: "2026-06-01", eftp: 263, activityName: null },
];

const meta = {
  title: "Training/EftpTrendChart",
  component: EftpTrendChart,
  tags: ["autodocs"],
  args: { data: points, currentEftp: 263 },
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EftpTrendChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], currentEftp: null, loading: true } };
export const Empty: Story = { args: { data: [], currentEftp: null } };
export const WithoutCurrentThreshold: Story = { args: { currentEftp: null } };
