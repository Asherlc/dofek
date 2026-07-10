import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";

const progressionRows = [
  {
    date: "2026-07-01",
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V2",
    gradeSortValue: 2,
  },
  {
    date: "2026-07-08",
    climbType: "boulder" as const,
    gradeSystem: "v_scale" as const,
    grade: "V4",
    gradeSortValue: 4,
  },
  {
    date: "2026-07-08",
    climbType: "route" as const,
    gradeSystem: "yds" as const,
    grade: "5.10a",
    gradeSortValue: 5101,
  },
];

const meta = {
  title: "Components/ClimbingGradeProgressionChart",
  component: ClimbingGradeProgressionChart,
  tags: ["autodocs"],
  args: {
    data: progressionRows,
    loading: false,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 640 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingGradeProgressionChart>;

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
