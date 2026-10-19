import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers";

const data = [
  climbingProgressionFixture(),
  climbingProgressionFixture("route", { ropeMethod: "top_rope" }),
  climbingProgressionFixture("route", { ropeMethod: "lead" }),
  climbingProgressionFixture("route"),
];
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
export const Sparse: Story = { args: { data: data.slice(0, 1) } };
export const AidStyles: Story = {
  args: {
    data: [
      climbingProgressionFixture("route", { ropeMethod: "lead" }),
      climbingProgressionFixture("route", { ropeMethod: "lead", usedAid: true }),
      climbingProgressionFixture("route", { ropeMethod: "lead", usedAid: null }),
    ],
  },
};
export const UnknownCategories: Story = {
  args: {
    data: [
      {
        ...climbingProgressionFixture("route", { ropeMethod: "lead" }),
        settings: ["unknown"],
        periods: climbingProgressionFixture("route", { ropeMethod: "lead" }).periods.map(
          (period) => ({
            ...period,
            settings: period.settings
              .slice(0, 1)
              .map((setting) => ({ ...setting, setting: "unknown", unknownOutcomes: 1 })),
          }),
        ),
      },
    ],
  },
};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
