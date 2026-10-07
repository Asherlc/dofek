import type { Meta, StoryObj } from "@storybook/react-native";
import { ClimbingTrainingCard } from "./ClimbingTrainingCard";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers";

const data = {
  gradeProgression: [climbingProgressionFixture()],
  volumeByGrade: [
    {
      climbType: "boulder",
      grade: "V3",
      gradeSortValue: 3,
      attempts: 8,
      recordedAttempts: 8,
      sends: 3,
    },
  ],
  sessionSummary: [
    {
      activityId: "climbing-session",
      date: "2026-10-04",
      name: "Bouldering",
      locationName: "Climbing gym",
      attempts: 8,
      sends: 3,
      hardestBoulderGrade: "V3",
      hardestRouteGrade: null,
    },
  ],
};
const meta = {
  title: "Components/ClimbingTrainingCard",
  component: ClimbingTrainingCard,
  args: { data, loading: false },
} satisfies Meta<typeof ClimbingTrainingCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: undefined } };
export const UnknownAttempts: Story = {
  args: {
    data: {
      ...data,
      volumeByGrade: [
        {
          climbType: "boulder",
          grade: "VB",
          gradeSortValue: -1,
          attempts: null,
          recordedAttempts: null,
          sends: 1,
        },
      ],
    },
  },
};
export const RecordedAttempts: Story = {
  args: {
    data: {
      ...data,
      volumeByGrade: [
        {
          climbType: "boulder",
          grade: "VB",
          gradeSortValue: -1,
          attempts: null,
          recordedAttempts: 4,
          sends: 1,
        },
      ],
    },
  },
};
export const PartialDataError: Story = {
  args: { data: { ...data, volumeByGrade: [{ grade: "invalid" }] } },
};
