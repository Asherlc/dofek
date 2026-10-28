import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers";

const data = climbingProgressionFixture();
const meta = {
  title: "Components/ClimbingGradeProgressionChart",
  component: ClimbingGradeProgressionChart,
  decorators: [
    (Story) => (
      <View style={{ width: "100%", maxWidth: 736, padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  parameters: { layout: "fullscreen" },
  args: { data, loading: false },
} satisfies Meta<typeof ClimbingGradeProgressionChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Sparse: Story = { args: { data: { ...data, periods: data.periods.slice(0, 1) } } };
export const MixedNativeScales: Story = {
  args: {
    data: {
      ...data,
      grades: [
        {
          key: "boulder-v4",
          climbKind: "boulder",
          gradeSystem: "font",
          grade: "6a",
          gradeSortValue: 65,
        },
        {
          key: "route-5.11a",
          climbKind: "route",
          gradeSystem: "french",
          grade: "6a",
          gradeSortValue: 65,
        },
      ],
    },
  },
};
export const UnknownOutcomes: Story = {
  args: {
    data: {
      ...data,
      periods: data.periods.map((period) => ({
        ...period,
        unknownOutcomes: period.climbingDays > 0 ? 1 : 0,
      })),
    },
  },
};
export const Loading: Story = { args: { data: null, loading: true } };
export const Empty: Story = { args: { data: null } };
