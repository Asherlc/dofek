import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingVolumeByGradeChart } from "./ClimbingVolumeByGradeChart.tsx";

const volumeRows = [
  {
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V1",
    gradeSortValue: 1,
    attempts: 6,
    recordedAttempts: 6,
    sends: 5,
  },
  {
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V3",
    gradeSortValue: 3,
    attempts: 8,
    recordedAttempts: 8,
    sends: 4,
  },
  {
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V5",
    gradeSortValue: 5,
    attempts: 3,
    recordedAttempts: 3,
    sends: 1,
  },
];

const meta = {
  title: "Components/ClimbingVolumeByGradeChart",
  component: ClimbingVolumeByGradeChart,
  tags: ["autodocs"],
  args: {
    data: volumeRows,
    loading: false,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 640 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingVolumeByGradeChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const UnknownAttemptCounts: Story = {
  args: {
    data: [
      {
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "VB",
        gradeSortValue: -1,
        attempts: null,
        recordedAttempts: null,
        sends: 1,
      },
      ...volumeRows.map((row) => ({ ...row, attempts: null, recordedAttempts: null })),
    ],
  },
};

export const RecordedAttemptSubtotals: Story = {
  args: {
    data: [
      {
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "VB",
        gradeSortValue: -1,
        attempts: null,
        recordedAttempts: 4,
        sends: 1,
      },
      {
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V0",
        gradeSortValue: 0,
        attempts: null,
        recordedAttempts: 0,
        sends: 0,
      },
      ...volumeRows,
    ],
  },
};

export const Loading: Story = {
  args: {
    data: [],
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    data: [],
  },
};
