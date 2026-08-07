import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingVolumeByGradeChart } from "./ClimbingVolumeByGradeChart.tsx";

const volumeRows = [
  {
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V1",
    gradeSortValue: 1,
    attempts: 6,
    sends: 5,
  },
  {
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V3",
    gradeSortValue: 3,
    attempts: 8,
    sends: 4,
  },
  {
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V5",
    gradeSortValue: 5,
    attempts: 3,
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
