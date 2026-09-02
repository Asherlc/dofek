import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HangboardingDetail as HangboardingDetailData } from "../../../server/src/repositories/hangboarding-repository.ts";
import { HangboardingDetail } from "./HangboardingDetail.tsx";

const data: HangboardingDetailData = {
  planName: "7/3 Repeaters",
  boardName: "Tension Board",
  segmentsError: null,
  summary: {
    durationSeconds: 300,
    workIntervalCount: 3,
    totalWorkDurationSeconds: 21,
    totalRestDurationSeconds: 106,
    exercises: [{ label: "19 mm edge", workIntervalCount: 3, workDurationSeconds: 21 }],
  },
};

const meta = {
  title: "Training/HangboardingDetail",
  component: HangboardingDetail,
  tags: ["autodocs"],
  args: { data, loading: false, error: null },
  decorators: [
    (Story) => (
      <div className="w-[820px] bg-page p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HangboardingDetail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SegmentWarning: Story = {
  args: {
    data: { ...data, segmentsError: "Some intervals had incomplete timestamps." },
  },
};

export const Loading: Story = { args: { data: undefined, loading: true, error: null } };
