import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import type { DataQualityOverview } from "../../server/src/repositories/data-quality-repository";
import { colors } from "../theme";
import { DataQualityCenter } from "./DataQualityCenter";

const overview: DataQualityOverview = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  window: { days: 30, endDate: "2026-07-22" },
  overallStatus: "attention",
  overallMessage: "2 data quality checks need review.",
  checks: [
    {
      key: "coverage",
      label: "Missing days",
      status: "attention",
      title: "Coverage gaps",
      message: "Nutrition data is missing for 5 of the last 30 days.",
      count: 5,
      lastObservedDate: null,
      details: ["25 of 30 days contain nutrition data."],
    },
    {
      key: "source_overlap",
      label: "Source overlap",
      status: "attention",
      title: "Some records have overlapping sources",
      message: "Review the source decisions before interpreting these records.",
      count: 2,
      lastObservedDate: "2026-07-21",
      details: ["Nutrition: 2 overlapping days (1 unresolved)."],
    },
  ],
};

const meta = {
  title: "Data Quality/DataQualityCenter",
  component: DataQualityCenter,
  args: { data: overview },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <View style={{ backgroundColor: colors.background, padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof DataQualityCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Attention: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: undefined, loading: false } };
