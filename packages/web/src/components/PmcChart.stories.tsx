import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PmcDataPoint, TssModelInfo } from "dofek-server/types";
import { PmcChart } from "./PmcChart.tsx";

const data: PmcDataPoint[] = Array.from({ length: 35 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 4, index + 1)).toISOString().slice(0, 10);
  const load = index % 7 === 1 ? 82 : index % 7 === 4 ? 55 : 0;
  const ctl = 42 + index * 0.55;
  const atl = 38 + Math.sin(index / 2.4) * 13 + load * 0.08;
  return {
    date,
    load,
    ctl: Math.round(ctl * 10) / 10,
    atl: Math.round(atl * 10) / 10,
    tsb: Math.round((ctl - atl) * 10) / 10,
  };
});

const learnedModel: TssModelInfo = {
  type: "learned",
  pairedActivities: 24,
  r2: 0.84,
  ftp: 268,
};

const meta = {
  title: "Training/PmcChart",
  component: PmcChart,
  tags: ["autodocs"],
  args: { data, model: learnedModel },
  decorators: [
    (Story) => (
      <div className="w-[880px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PmcChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], model: null, loading: true } };
export const Empty: Story = { args: { data: [], model: null } };
export const GenericHeartRateModel: Story = {
  args: {
    model: { type: "generic", pairedActivities: 6, r2: null, ftp: 252 },
  },
};
