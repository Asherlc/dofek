import type { Meta, StoryObj } from "@storybook/react-native";
import type { CalendarDay } from "dofek-server/types";
import { ActivityHeatmap } from "./ActivityHeatmap";

const data: CalendarDay[] = [
  {
    date: "2026-03-10",
    activityCount: 0,
    totalMinutes: 0,
    activityTypes: [],
    trainingTimeBand: "none",
    trainingTimeMeaning: "No recorded training; this may be a recovery/rest day.",
  },
  {
    date: "2026-03-12",
    activityCount: 1,
    totalMinutes: 45,
    activityTypes: ["running"],
    trainingTimeBand: "moderate",
    trainingTimeMeaning: "Moderate recorded training volume.",
  },
  {
    date: "2026-03-15",
    activityCount: 2,
    totalMinutes: 135,
    activityTypes: ["cycling", "strength"],
    trainingTimeBand: "very_high",
    trainingTimeMeaning:
      "Very high training volume; recovery context matters, and duration alone does not prove overload.",
  },
];

const meta = {
  title: "Training/ActivityHeatmap",
  component: ActivityHeatmap,
  tags: ["autodocs"],
  args: { data },
} satisfies Meta<typeof ActivityHeatmap>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { data: [] },
};
