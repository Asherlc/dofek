import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CalendarDay } from "dofek-server/types";
import { TrainingCalendar } from "./TrainingCalendar.tsx";

const data: CalendarDay[] = [
  {
    date: "2026-03-10",
    activityCount: 1,
    totalMinutes: 45,
    activityTypes: ["running"],
    trainingTimeBand: "moderate",
    trainingTimeMeaning: "Moderate recorded training volume.",
  },
  {
    date: "2026-03-12",
    activityCount: 2,
    totalMinutes: 135,
    activityTypes: ["cycling", "strength"],
    trainingTimeBand: "very_high",
    trainingTimeMeaning:
      "Very high training volume; recovery context matters, and duration alone does not prove overload.",
  },
  {
    date: "2026-03-15",
    activityCount: 1,
    totalMinutes: 30,
    activityTypes: ["walking"],
    trainingTimeBand: "light",
    trainingTimeMeaning: "Light recorded training volume.",
  },
  {
    date: "2026-03-18",
    activityCount: 1,
    totalMinutes: 72,
    activityTypes: ["running"],
    trainingTimeBand: "high",
    trainingTimeMeaning:
      "High training volume; compare with recovery before stacking another hard day.",
  },
];

const meta = {
  title: "Training/TrainingCalendar",
  component: TrainingCalendar,
  tags: ["autodocs"],
  args: {
    data,
  },
  decorators: [
    (Story) => (
      <div className="w-[900px] bg-page p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TrainingCalendar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Compact: Story = {
  args: {
    height: 140,
  },
};

export const Empty: Story = {
  args: {
    data: [],
  },
};
