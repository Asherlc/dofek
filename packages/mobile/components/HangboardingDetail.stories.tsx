import type { Meta, StoryObj } from "@storybook/react-native";
import type { HangboardingDetail as HangboardingDetailData } from "../../server/src/repositories/hangboarding-repository.ts";
import { HangboardingDetail } from "./HangboardingDetail";

const data: HangboardingDetailData = {
  planName: "7/3 Repeaters",
  sessionId: "session-1",
  boardId: "board-1",
  boardName: "Tension Board",
  segmentsError: null,
  intervals: [
    {
      id: "interval-1",
      intervalIndex: 0,
      label: "Step 1: 19 mm edge",
      intervalType: "work",
      startedAt: "2026-08-07T14:00:00.000Z",
      endedAt: "2026-08-07T14:00:07.000Z",
      durationSeconds: 7,
    },
    {
      id: "interval-2",
      intervalIndex: 1,
      label: "Rest",
      intervalType: "rest",
      startedAt: "2026-08-07T14:00:07.000Z",
      endedAt: "2026-08-07T14:00:53.000Z",
      durationSeconds: 46,
    },
  ],
};

const meta = {
  title: "Components/HangboardingDetail",
  component: HangboardingDetail,
  args: { data, loading: false, error: null },
} satisfies Meta<typeof HangboardingDetail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const SegmentWarning: Story = {
  args: { data: { ...data, segmentsError: "Some intervals had incomplete timestamps." } },
};
export const Loading: Story = { args: { data: undefined, loading: true, error: null } };
export const ErrorState: Story = {
  args: { data: undefined, loading: false, error: new Error("Hangboarding details unavailable") },
};
