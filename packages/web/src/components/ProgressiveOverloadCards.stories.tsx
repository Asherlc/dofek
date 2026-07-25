import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ProgressiveOverloadRow } from "dofek-server/types";
import { ProgressiveOverloadCards } from "./ProgressiveOverloadCards.tsx";

const exercises: ProgressiveOverloadRow[] = [
  {
    exerciseName: "Back Squat",
    weeklyVolumes: [4800, 5100, 5450, 5800, 6150],
    slopeKgPerWeek: 327.5,
    isProgressing: true,
  },
  {
    exerciseName: "Bench Press",
    weeklyVolumes: [3200, 3310, 3380, 3420, 3490],
    slopeKgPerWeek: 68.5,
    isProgressing: true,
  },
  {
    exerciseName: "Deadlift",
    weeklyVolumes: [4200, 4100, 4050, 3980, 3900],
    slopeKgPerWeek: -73,
    isProgressing: false,
  },
];

const meta = {
  title: "Strength/ProgressiveOverloadCards",
  component: ProgressiveOverloadCards,
  tags: ["autodocs"],
  args: {
    exercises,
  },
  decorators: [
    (Story) => (
      <div className="w-[900px] bg-page p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProgressiveOverloadCards>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    exercises: [],
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    exercises: [],
  },
};
